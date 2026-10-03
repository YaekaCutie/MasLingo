import unittest

from PIL import Image, ImageDraw

from backend.ocr.bubble_detector import (
    MAX_TEXT_REGIONS,
    _share_text_line,
    detect_text_regions,
)


class BubbleDetectorTests(unittest.TestCase):
    def test_groups_neighboring_glyphs_and_keeps_separate_text_regions(self):
        image = Image.new("RGB", (400, 200), "white")
        draw = ImageDraw.Draw(image)
        for left in (30, 47, 64, 81):
            draw.rectangle((left, 40, left + 13, 60), fill="black")
        for left in (270, 287, 304):
            draw.rectangle((left, 120, left + 13, 140), fill="black")

        regions = detect_text_regions(image)

        self.assertEqual(len(regions), 2)
        self.assertLess(regions[0][0], 140)
        self.assertGreater(regions[1][0], 240)

    def test_groups_adjacent_vertical_lines_into_one_ocr_region(self):
        image = Image.new("RGB", (500, 450), "white")
        draw = ImageDraw.Draw(image)
        for left in (190, 220):
            for top in (165, 195, 225, 255, 285):
                draw.rectangle((left, top, left + 11, top + 15), fill="black")

        regions = detect_text_regions(image)

        self.assertEqual(len(regions), 1)
        left, top, right, bottom = regions[0]
        self.assertLessEqual(left, 190)
        self.assertGreaterEqual(right, 231)
        self.assertLessEqual(top, 165)
        self.assertGreaterEqual(bottom, 301)

    def test_does_not_merge_neighboring_regions_with_different_scales(self):
        broad_hatching = (458, 45, 646, 412, 16612)
        adjacent_text_column = (321, 61, 442, 237, 5915)

        self.assertFalse(_share_text_line(broad_hatching, adjacent_text_column))

    def test_does_not_merge_separate_tall_vertical_regions_across_a_gap(self):
        upper_region = (458, 45, 646, 412, 16612)
        lower_region = (463, 477, 609, 692, 5691)

        self.assertFalse(_share_text_line(upper_region, lower_region))

    def test_merges_separated_segments_of_same_vertical_dialogue(self):
        first_segment = (794, 1163, 983, 1325, 4550)
        second_segment = (849, 1402, 981, 1519, 946)

        self.assertTrue(_share_text_line(first_segment, second_segment))

    def test_does_not_merge_far_apart_vertical_segments(self):
        main_columns = (54, 68, 167, 217, 3709)
        ending_column = (24, 194, 48, 248, 290)

        self.assertFalse(_share_text_line(main_columns, ending_column))

    def test_returns_no_regions_for_blank_page(self):
        self.assertEqual(detect_text_regions(Image.new("RGB", (240, 160), "white")), [])

    def test_detects_enclosed_speech_balloon_as_a_single_ocr_region(self):
        image = Image.new("RGB", (400, 400), (210, 210, 210))
        draw = ImageDraw.Draw(image)
        draw.ellipse((135, 112, 265, 287), fill="white", outline="black", width=3)
        for left in (151, 171, 191, 211, 231):
            for top in (135, 157, 179, 201, 223):
                draw.rectangle((left, top, left + 5, top + 10), fill="black")

        regions = detect_text_regions(image)

        self.assertTrue(any(
            left <= 138 and right >= 263 and top <= 115 and bottom >= 285
            for left, top, right, bottom in regions
        ))
        self.assertTrue(all(
            (right - left) * (bottom - top) <= 400 * 400 * 0.18
            for left, top, right, bottom in regions
        ))

    def test_does_not_treat_a_wide_art_panel_as_a_balloon_crop(self):
        image = Image.new("RGB", (400, 400), (210, 210, 210))
        draw = ImageDraw.Draw(image)
        draw.rectangle((90, 120, 310, 200), fill="white", outline="black", width=3)
        for left in (130, 155, 180, 205, 230, 255):
            draw.rectangle((left, 145, left + 8, 172), fill="black")

        regions = detect_text_regions(image)

        self.assertFalse(any(
            left <= 90 and right >= 310 and top <= 120 and bottom >= 200
            for left, top, right, bottom in regions
        ))

    def test_caps_regions_for_landscape_and_portrait_pages(self):
        for size, horizontal in (((1600, 180), True), ((180, 1600), False)):
            with self.subTest(size=size):
                image = Image.new("RGB", size, "white")
                draw = ImageDraw.Draw(image)
                for index in range(25):
                    if horizontal:
                        left, top = 10 + index * 60, 70
                        width, height = 12, 18
                    else:
                        left, top = 70, 10 + index * 60
                        width, height = 12, 10
                    draw.rectangle((left, top, left + width, top + height), fill="black")

                regions = detect_text_regions(image)

                self.assertEqual(len(regions), MAX_TEXT_REGIONS)
                self.assertTrue(all(
                    0 <= left < right <= size[0] and 0 <= top < bottom <= size[1]
                    for left, top, right, bottom in regions
                ))
                self.assertTrue(all(
                    (right - left) * (bottom - top) <= size[0] * size[1] * 0.05
                    for left, top, right, bottom in regions
                ))

    def test_finds_text_groups_on_a_dense_comic_page(self):
        image = Image.new("RGB", (768, 1119), "white")
        draw = ImageDraw.Draw(image)
        for x in (24, 260, 484, 744):
            draw.line((x, 0, x, 1118), fill="black", width=3)
        for y in (0, 280, 550, 820, 1118):
            draw.line((24, y, 484, y), fill="black", width=3)

        expected_region = (280, 60, 332, 170)
        left, top, right, bottom = expected_region
        for row in range(5):
            for column in range(3):
                x = left + column * 17
                y = top + row * 22
                draw.rectangle((x, y, x + 11, y + 15), fill="black")

        regions = detect_text_regions(image)

        self.assertTrue(regions)
        self.assertTrue(any(
            left <= region_right and right >= region_left
            and top <= region_bottom and bottom >= region_top
            for region_left, region_top, region_right, region_bottom in regions
        ))

    def test_thin_hatching_does_not_collapse_lettering_into_one_page_region(self):
        image = Image.new("RGB", (1000, 700), (235, 235, 235))
        draw = ImageDraw.Draw(image)
        # A dense, one-pixel manga hatch/grid is connected after dilation and
        # used to win candidate ranking, hiding both text groups in one box.
        for x in range(100, 880, 7):
            draw.line((x, 100, x, 560), fill=(65, 65, 65), width=1)
        for y in range(100, 560, 7):
            draw.line((100, y, 880, y), fill=(65, 65, 65), width=1)
        for left, top in ((170, 180), (650, 440)):
            for row in range(2):
                for column in range(6):
                    x, y = left + column * 24, top + row * 32
                    draw.rectangle((x, y, x + 13, y + 21), fill="black")

        regions = detect_text_regions(image)

        self.assertEqual(len(regions), 2)
        self.assertTrue(all(
            right - left < 240 and bottom - top < 120
            for left, top, right, bottom in regions
        ))
        self.assertTrue(any(
            left <= 170 and right >= 314 and top <= 180 and bottom >= 244
            for left, top, right, bottom in regions
        ))
        self.assertTrue(any(
            left <= 650 and right >= 794 and top <= 440 and bottom >= 504
            for left, top, right, bottom in regions
        ))

    def test_finds_page_text_against_dark_reader_background(self):
        image = Image.new("RGB", (900, 600), (24, 25, 23))
        draw = ImageDraw.Draw(image)
        draw.rectangle((240, 60, 660, 540), fill="white")
        for x in (280, 390, 500, 590):
            for row in range(5):
                y = 130 + row * 22
                draw.rectangle((x, y, x + 9, y + 13), fill="black")

        regions = detect_text_regions(image)

        self.assertTrue(any(
            left >= 240 and right <= 660 and bottom <= 300
            for left, _top, right, bottom in regions
        ))

    def test_finds_light_lettering_embedded_in_dark_artwork(self):
        image = Image.new("RGB", (480, 320), (30, 30, 34))
        draw = ImageDraw.Draw(image)
        for left in (130, 153, 176, 199):
            draw.rectangle((left, 120, left + 14, 148), fill=(248, 248, 248))

        regions = detect_text_regions(image)

        self.assertTrue(any(
            left <= 130 and right >= 213 and top <= 120 and bottom >= 148
            for left, top, right, bottom in regions
        ))

    def test_finds_mid_tone_lettering_embedded_in_artwork(self):
        image = Image.new("RGB", (560, 360), (156, 160, 168))
        draw = ImageDraw.Draw(image)
        for left in (170, 193, 216, 239):
            draw.rectangle((left, 145, left + 14, 173), fill=(212, 214, 220))

        regions = detect_text_regions(image)

        self.assertTrue(any(
            left <= 170 and right >= 253 and top <= 145 and bottom >= 173
            for left, top, right, bottom in regions
        ))

    def test_ignores_solid_light_artwork_without_lettering(self):
        image = Image.new("RGB", (480, 320), (30, 30, 34))
        ImageDraw.Draw(image).rectangle((130, 100, 340, 220), fill=(248, 248, 248))

        self.assertEqual(detect_text_regions(image), [])


if __name__ == "__main__":
    unittest.main()
