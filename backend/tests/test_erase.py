import base64
import json
from io import BytesIO
import unittest

import numpy as np
from PIL import Image, ImageDraw

from backend.image.erase import make_erase_patch


class EraseTests(unittest.TestCase):
    def test_repair_does_not_change_unmasked_illustration_or_frame(self):
        clean = Image.new("RGB", (140, 100), (240, 210, 160))
        ImageDraw.Draw(clean).line((0, 30, 139, 30), fill="black", width=3)
        source = clean.copy()
        ImageDraw.Draw(source).rectangle((40, 45, 47, 68), fill=(45, 20, 80))
        probability = np.zeros((100,140), dtype=np.float32)
        probability[45:69,40:48] = 1
        patch = make_erase_patch(source, (10, 15, 130, 85), probability)
        self.assertTrue(patch["safe"])
        self.assertIs(type(patch["safe"]),bool)
        json.dumps(patch)  # HTTP responses must not contain NumPy scalars.
        tile = Image.open(BytesIO(base64.b64decode(patch["image"].split(",")[1])))
        repaired = source.convert("RGBA")
        repaired.alpha_composite(tile,(patch["rect"]["left"],patch["rect"]["top"]))
        self.assertTrue(np.array_equal(np.asarray(repaired.convert("RGB")), np.asarray(clean)))

    def test_no_confident_glyphs_returns_no_repair(self):
        self.assertIsNone(make_erase_patch(Image.new("RGB",(20,20)), (0,0,20,20),
                                           np.zeros((20,20),dtype=np.float32)))

    def test_weak_isolated_marks_are_not_erased(self):
        source = Image.new("RGB", (40,40), "white")
        probability = np.zeros((40,40),dtype=np.float32)
        probability[10:15,10:15] = 0.3
        self.assertIsNone(make_erase_patch(source, (0,0,40,40), probability))

    def test_cleans_jpeg_fringe_without_erasing_a_nearby_black_line(self):
        source = Image.new("RGB",(100,80),"white")
        draw = ImageDraw.Draw(source)
        draw.rectangle((41,20,44,60),fill=(249,249,249))
        draw.rectangle((46,20,48,60),fill="black")
        draw.rectangle((50,20,56,60),fill="black")
        probability = np.zeros((80,100),dtype=np.float32)
        probability[20:61,50:57] = 1
        # Inspect the repair algorithm independently of the conservative policy.
        patch = make_erase_patch(source, (10,10,90,70), probability, preserve_artwork=False)
        layer = Image.open(BytesIO(base64.b64decode(patch["image"].split(",")[1])))
        repaired = source.convert("RGBA")
        repaired.alpha_composite(layer,(patch["rect"]["left"],patch["rect"]["top"]))
        self.assertEqual(repaired.getpixel((44,40))[:3],(255,255,255))
        self.assertEqual(repaired.getpixel((46,40))[:3],(0,0,0))

    def test_hatching_preserves_original_instead_of_returning_a_repair_image(self):
        image = Image.new("RGB", (160,120), "white")
        draw = ImageDraw.Draw(image)
        for x in range(0,160,5):
            draw.line((x,0,x,119),fill="black",width=2)
        draw.rectangle((60,35,72,85),fill="black")
        probability = np.zeros((120,160),dtype=np.float32)
        probability[35:86,60:73] = 1
        patch = make_erase_patch(image,(40,20,100,100),probability)
        self.assertFalse(patch["safe"])
        self.assertIsNone(patch["image"])
        self.assertEqual(patch["reason"],"textured-background")

    def test_smooth_gradient_can_still_use_inline_repair(self):
        pixels = np.zeros((140,160,3),dtype=np.uint8)
        for y in range(140): pixels[y] = [100+y//4,130+y//5,160+y//6]
        source = Image.fromarray(pixels)
        ImageDraw.Draw(source).rectangle((60,45,70,90),fill="black")
        probability = np.zeros((140,160),dtype=np.float32)
        probability[45:91,60:71] = 1
        patch = make_erase_patch(source,(40,20,100,115),probability)
        self.assertTrue(patch["safe"])
        self.assertTrue(patch["image"].startswith("data:image/png;base64,"))

    def test_flat_balloon_near_its_outline_is_repaired_without_erasing_the_outline(self):
        for paper in [(255,255,255),(246,213,145)]:
            with self.subTest(paper=paper):
                clean = Image.new("RGB",(180,160),(35,90,115))
                ImageDraw.Draw(clean).ellipse((15,10,155,145),fill=paper,outline="black",width=3)
                source = clean.copy()
                ImageDraw.Draw(source).rectangle((143,65,147,85),fill="black")
                probability = np.zeros((160,180),np.float32)
                probability[65:86,143:148] = 1
                patch = make_erase_patch(source,(135,55,155,98),probability)
                self.assertTrue(patch["safe"])
                self.assertEqual(patch["quality"]["background"],"bubble")
                layer = Image.open(BytesIO(base64.b64decode(patch["image"].split(",")[1])))
                repaired = source.convert("RGBA")
                repaired.alpha_composite(layer,(patch["rect"]["left"],patch["rect"]["top"]))
                np.testing.assert_array_equal(np.asarray(repaired.convert("RGB")),np.asarray(clean))

    def test_enclosed_textured_paper_is_not_mistaken_for_flat_balloon_fill(self):
        image = Image.new("RGB",(200,180),(35,90,115))
        draw = ImageDraw.Draw(image)
        draw.rectangle((15,10,185,165),fill="white",outline="black",width=3)
        for x in range(25,180,5):draw.line((x,15,x,160),fill=(110,110,110),width=2)
        draw.rectangle((80,55,91,110),fill="black")
        probability = np.zeros((180,200),np.float32)
        probability[55:111,80:92] = 1
        self.assertFalse(make_erase_patch(image,(65,40,110,125),probability)["safe"])
