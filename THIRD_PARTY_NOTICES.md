# Comic text detection model

The local detector uses `comictextdetector.pt.onnx`, a pretrained model from
[comic-text-detector](https://github.com/dmMaze/comic-text-detector), distributed
by the [manga-image-translator beta-0.2.1 release](https://github.com/zyddnys/manga-image-translator/releases/tag/beta-0.2.1).
The upstream project is licensed under [GPL-3.0](https://github.com/dmMaze/comic-text-detector/blob/master/LICENSE).
Keep the upstream notices and license with any redistribution of those weights.
The upstream license text is included in `third_party/comic-text-detector-LICENSE.txt`.
The model is downloaded into the local model cache and is not committed here.

Pinned file SHA-256:
`1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f`.

The inference wrapper and transparent repair layer in this repository are
implemented locally; they do not import upstream Python source files.
