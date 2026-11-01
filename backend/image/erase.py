"""Return a transparent repair layer; pixels outside glyphs stay untouched."""
import base64
from io import BytesIO

import numpy as np
from PIL import Image


def _bubble_interior(image, box, probability, mask, patch_rect, background):
    """Find bounded flat paper around text without treating its outline as texture."""
    import cv2
    left, top, right, bottom = box
    context = max(64, min(640, max(right-left,bottom-top)*4))
    x0,y0 = max(0,left-context),max(0,top-context)
    x1,y1 = min(image.width,right+context),min(image.height,bottom+context)
    pixels = np.asarray(image.crop((x0,y0,x1,y1)).convert("RGB"))
    paper = (np.max(np.abs(pixels.astype(np.float32)-background),axis=2) <= 24).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(paper,connectivity=8)
    px,py = patch_rect[0]-x0,patch_rect[1]-y0
    local_labels = labels[py:py+mask.shape[0],px:px+mask.shape[1]]
    band = (cv2.dilate(mask,np.ones((5,5),np.uint8))>0) & (mask==0)
    votes = np.bincount(local_labels[band].ravel(),minlength=count)
    votes[0] = 0
    for label in np.argsort(votes)[::-1][:3]:
        if not votes[label]:
            continue
        x,y,w,h,area = stats[label]
        if area<64 or x==0 or y==0 or x+w>=pixels.shape[1] or y+h>=pixels.shape[0]:
            continue
        if w*h < (right-left)*(bottom-top)*1.2:
            continue  # A glyph's white outline is not a speech balloon.
        contours,_ = cv2.findContours((labels==label).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        interior = np.zeros(labels.shape,np.uint8)
        cv2.drawContours(interior,contours,-1,1,cv2.FILLED)
        local = interior[py:py+mask.shape[0],px:px+mask.shape[1]]
        if float(np.mean(local[mask>0])) < .98:
            continue
        # Exclude all detected text in this balloon, including another paragraph.
        nontext = (interior>0) & (probability[y0:y1,x0:x1]<.12)
        if np.count_nonzero(nontext)<64 or float(np.mean(paper[nontext]))<.97:
            continue
        return local>0
    return None


def make_erase_patch(image, box, probability, *, preserve_artwork=True):
    import cv2
    left, top, right, bottom = box
    pad = 4
    x0, y0 = max(0, left-pad), max(0, top-pad)
    x1, y1 = min(image.width, right+pad), min(image.height, bottom+pad)
    pixels = np.asarray(image.crop((x0, y0, x1, y1)).convert("RGB")).copy()
    prediction = probability[y0:y1, x0:x1]
    support = np.zeros(prediction.shape, dtype=np.uint8)
    support[top-y0:bottom-y0, left-x0:right-x0] = 1
    # Admit uncertain edges only when connected to a confident glyph seed.
    weak = ((prediction > 0.18) & (support > 0)).astype(np.uint8)
    seeds = (prediction > 0.55) & (support > 0)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(weak, connectivity=8)
    mask = np.zeros_like(weak)
    for label in range(1, count):
        component = labels == label
        if stats[label, cv2.CC_STAT_AREA] >= 3 and np.any(seeds & component):
            mask[component] = 255
    # Cover antialias/JPEG fringes in source pixels; display zoom must not
    # change the amount of artwork that gets repaired.
    radius = 2 if min(right-left, bottom-top) >= 48 else 1
    mask = cv2.dilate(mask, np.ones((radius*2+1, radius*2+1), np.uint8))
    mask *= support
    if not mask.any():
        return None
    outside = pixels[mask == 0]
    background = np.median(outside, axis=0) if len(outside) else np.array([255, 255, 255])
    near = (cv2.dilate(mask,np.ones((3,3),np.uint8))>0) & (mask==0)
    neighbours = pixels[near]
    if len(neighbours)>=8:
        local_background = np.median(neighbours,axis=0)
        if np.quantile(np.max(np.abs(neighbours.astype(np.float32)-local_background),axis=1),.6)<12:
            background = local_background
    difference = np.linalg.norm(outside.astype(np.float32) - background, axis=1)
    flat = bool(len(difference) > 0 and np.quantile(difference, 0.85) < 12)
    # Sample beyond the antialias band. High-frequency content here means that
    # an inpaint would have to invent hair, hatching or screentone behind text.
    ring = (cv2.dilate(mask, np.ones((13, 13), np.uint8)) > 0) & (
        cv2.dilate(mask, np.ones((5, 5), np.uint8)) == 0)
    if np.count_nonzero(ring) < 32:
        ring = mask == 0
    smooth = cv2.GaussianBlur(pixels.astype(np.float32), (0, 0), 1.2)
    texture = np.max(np.abs(pixels.astype(np.float32) - smooth), axis=2)
    texture_ratio = float(np.mean(texture[ring] > 8)) if ring.any() else 1.0
    coverage = float(np.mean(mask > 0))
    safe = bool(texture_ratio <= 0.08 and (flat or coverage <= 0.55))
    bubble = None
    if not safe:
        bubble = _bubble_interior(image,box,probability,mask,(x0,y0),background)
        if bubble is not None:
            mask[~bubble] = 0
            flat, safe = True, True
    rect = {"left": x0, "top": y0, "width": x1-x0, "height": y1-y0}
    quality = {"texture_ratio": round(texture_ratio, 4), "mask_coverage": round(coverage, 4),
               "background": "bubble" if bubble is not None else "flat" if flat else "smooth" if safe else "textured"}
    if preserve_artwork and not safe:
        return {"image": None, "rect": rect, "luminance": float(background @ np.array([0.299,0.587,0.114])),
                "safe": False, "reason": "textured-background", "quality": quality}
    if flat:
        # JPEG ringing can sit several pixels beyond the predicted stroke.
        # Only admit near-background colours in that fringe: a dark frame or
        # illustration line beside the lettering must remain untouched.
        fringe = cv2.dilate(mask, np.ones((9, 9), np.uint8))
        distance = np.max(np.abs(pixels.astype(np.float32) - background), axis=2)
        mask[(fringe > 0) & (distance <= 12) & (support > 0)] = 255
        if bubble is not None:
            mask[~bubble] = 0
        repaired = np.broadcast_to(background.astype(np.uint8), pixels.shape)
    else:
        repaired = cv2.inpaint(pixels, mask, 3, cv2.INPAINT_TELEA)
    output = np.dstack((repaired, mask))
    output[mask == 0, :3] = 0
    encoded = BytesIO()
    Image.fromarray(output).save(encoded, format="PNG")
    repaired_ink = repaired[mask > 0]
    luminance = float(np.median(repaired_ink @ np.array([0.299, 0.587, 0.114]))) if len(repaired_ink) else 255.0
    return {"image": "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii"),
            "rect": rect, "luminance": luminance, "safe": safe, "quality": quality}
