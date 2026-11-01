import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
from PIL import Image

from backend.ocr.text_detector import detect_text_regions, ensure_model


class TextDetectorTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {"MAS_TEXT_DETECTOR": "neural"})
        environment.start()
        self.addCleanup(environment.stop)

    @patch("backend.ocr.text_detector.get_detector")
    def test_keeps_rgb_channels_and_maps_boxes_to_original_pixels(self, get_detector):
        model = get_detector.return_value
        model.get_inputs.return_value = [MagicMock(name="images")]
        model.get_inputs.return_value[0].name = "images"
        rows = np.array([[[256,512,120,256,0.99,0.01,0.99]]], dtype=np.float32)
        model.run.return_value = [rows, np.zeros((1,1,1024,1024),np.float32),
                                  np.zeros((1,2,1024,1024),np.float32)]
        regions = detect_text_regions(Image.new("RGB", (100,200), (30,50,70)))
        tensor = model.run.call_args.args[1]["images"]
        np.testing.assert_allclose(tensor[0,:,0,0], np.array([30,50,70])/255, atol=1e-7)
        self.assertTrue(np.all(tensor[0,:,:,512:] == 0))
        self.assertEqual(regions, [(32,69,67,131)])
        self.assertEqual(regions.mask.shape, (200,100))

    @patch("backend.ocr.text_detector.get_detector")
    def test_duplicate_block_proposals_produce_one_region(self, get_detector):
        model = get_detector.return_value
        rows = np.array([[[512,512,200,300,0.99,0.01,0.99],
                          [513,513,200,300,0.9,0.01,0.99]]], dtype=np.float32)
        model.run.return_value = [rows, np.zeros((1,1,1024,1024),np.float32),
                                  np.zeros((1,2,1024,1024),np.float32)]
        self.assertEqual(len(detect_text_regions(Image.new("RGB", (400,400)))),1)

    @patch("backend.ocr.text_detector.get_detector")
    def test_one_coarse_block_splits_at_gap_between_two_balloons(self, get_detector):
        model = get_detector.return_value
        lines = np.zeros((1,2,1024,1024),np.float32)
        glyphs = np.zeros((1,1,1024,1024),np.float32)
        for x in (100,120,200,220):
            lines[0,0,100:200,x:x+10] = 0.95
            glyphs[0,0,98:202,x-2:x+12] = 0.95
        model.run.return_value = [np.array([[[165,150,150,120,0.99,0.01,0.99]]],np.float32), glyphs, lines]
        regions = detect_text_regions(Image.new("RGB",(1024,1024)))
        self.assertEqual(len(regions),2)
        left_group,right_group = sorted(regions,key=lambda box:box[0])
        self.assertLess(left_group[2],160)
        self.assertGreater(right_group[0],160)

    @patch("backend.ocr.text_detector.get_detector")
    def test_small_kana_crop_keeps_glyph_fringe_without_nearby_frame(self, get_detector):
        model = get_detector.return_value
        lines = np.zeros((1,2,1024,1024),np.float32)
        glyphs = np.zeros((1,1,1024,1024),np.float32)
        lines[0,0,232:249,54:70] = 0.95
        glyphs[0,0,229:252,52:72] = 0.95
        model.run.return_value = [np.array([[[62,240,21,26,0.99,0.01,0.99]]],np.float32),glyphs,lines]
        regions = detect_text_regions(Image.new("RGB",(1024,1024)))
        self.assertEqual(len(regions),1)
        left,top,right,bottom = regions[0]
        self.assertGreater(left,42,"The balloon frame at x=42 must stay outside the OCR crop")
        self.assertLessEqual(left,52)
        self.assertLessEqual(top,229)
        self.assertGreaterEqual(right,72)
        self.assertGreaterEqual(bottom,252)

    @patch("backend.ocr.text_detector.get_detector")
    def test_separate_vertical_paragraphs_do_not_lose_short_leading_kana(self, get_detector):
        model = get_detector.return_value
        lines = np.zeros((1,2,1024,1024),np.float32)
        lines[0,0,100:114,100:114] = 0.95
        lines[0,0,165:225,100:114] = 0.95
        model.run.return_value = [np.array([[[107,162,40,150,0.99,0.01,0.99]]],np.float32),
                                  np.zeros((1,1,1024,1024),np.float32),lines]
        regions = detect_text_regions(Image.new("RGB",(1024,1024)))
        self.assertEqual(len(regions),2)
        self.assertLess(regions[0][3],regions[1][1])

    @patch("backend.ocr.text_detector.get_detector")
    def test_lines_in_padding_do_not_create_invalid_crops(self, get_detector):
        model = get_detector.return_value
        lines = np.zeros((1,2,1024,1024),np.float32)
        lines[0,0,300:400,800:900] = 0.95
        model.run.return_value = [np.zeros((1,0,7),np.float32),
                                  np.zeros((1,1,1024,1024),np.float32), lines]
        self.assertEqual(detect_text_regions(Image.new("RGB",(100,200))), [])

    def test_damaged_model_is_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"incomplete model")
            with patch("backend.ocr.text_detector.model_path", return_value=path):
                with self.assertRaisesRegex(RuntimeError, "校验失败"):
                    ensure_model()
