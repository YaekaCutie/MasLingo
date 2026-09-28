from io import BytesIO
from PIL import Image
def decode_image(data: bytes) -> Image.Image:
    return Image.open(BytesIO(data)).convert("RGB")