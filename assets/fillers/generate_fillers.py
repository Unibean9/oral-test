#!/usr/bin/env python3
"""One-off script to pre-render the static filler clips the FE plays immediately on turn
submit, while the real facilitator reply is still round-tripping through Claude + TTS.
Not part of the live request path — filler audio must never be synthesized per-turn, since
that would add latency in front of the real reply instead of covering for it.

Run with an isolated TTS environment's python, e.g.:
    python -m venv .venv-fillers
    .venv-fillers/Scripts/pip install vieneu==3.2.3 soundfile
    .venv-fillers/Scripts/python.exe generate_fillers.py [--force]
"""
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import soundfile
from vieneu import Vieneu

HERE = Path(__file__).parent

FORCE = "--force" in sys.argv
MIN_DURATION_S = 3.5

# 5 phrases per brainstorm phase, keyed exactly like PHASE_KEYS (src/brainstorm/contracts.ts).
# Each line runs roughly 5-7s at VieNeu's natural speaking rate: long enough to cover the
# facilitator's real thinking time, short enough that it never overruns before the real reply
# starts streaming. Sounds like the facilitator thinking about THIS phase's kind of problem —
# never states the phase name.
FILLER_TEXTS = {
    "framing": [
        "À khoan, mình muốn chắc là cả nhóm đang nói về cùng một vấn đề đã... có khi cái mọi người vừa kể chỉ là một phần thôi.",
        "Ai là người bị ảnh hưởng nhiều nhất trong chuyện này nhỉ. Mình đang cố hình dung lại cho rõ.",
        "Câu hỏi thật sự nhóm mình cần trả lời là gì ấy nhỉ, mình sợ là tụi mình đang hỏi hơi lệch.",
        "Mình cần một chút để sắp lại bối cảnh trong đầu đã, sợ hiểu sai ý cả nhóm thì phí công.",
        "Có vài chi tiết nãy giờ nghe qua thấy quan trọng đấy... để mình xem cái nào mới là gốc, cái nào chỉ là biểu hiện thôi.",
    ],
    "diverging": [
        "Vẫn còn thiếu thiếu gì đó ấy nhỉ. Mình đang nghĩ xem còn hướng nào chưa ai nhắc tới không.",
        "Thử lật ngược vấn đề này xem sao ha, biết đâu ra thêm được vài ý hay.",
        "Nhóm mình đang có kha khá ý rồi đấy, để mình xem còn chỗ nào mở rộng thêm được không nhé.",
        "Khoan đã, đừng dừng lại ở mấy ý quen thuộc vội... mình đang tìm thêm góc khác.",
        "Ồ, cái này thú vị. Để mình nghĩ xem có cách nào khác hẳn với mấy ý vừa nêu không.",
    ],
    "shifting": [
        "Nếu đứng ở vị trí người dùng thì chuyện này trông sẽ khác thế nào nhỉ, mình đang thử hình dung.",
        "Thử đảo ngược cái giả định mà nhóm mình đang mặc định xem... biết đâu dẫn tới cái gì hay ho.",
        "Đôi khi đi vòng một chút lại nhanh hơn đi thẳng đấy. Mình đang tìm xem có lối nào khác không.",
        "Khoan, thử nhìn từ góc hoàn toàn khác xem sao, đổi chỗ đứng một chút biết đâu thấy được điều mới.",
        "Mình đang có một góc nhìn hơi khác với mọi người, để mình sắp lại ý cho gọn đã.",
    ],
    "critiquing": [
        "Ý này nghe hay đấy nhưng mình muốn hỏi khó một chút xem nó có đứng vững không nhé, hỏi thật lòng thôi.",
        "Điểm yếu lớn nhất của hướng này nằm ở đâu nhỉ... để mình nghĩ kỹ hơn.",
        "Giả định nào ở đây rủi ro nhất nếu hóa ra sai vậy ta. Mình đang cân nhắc.",
        "Thử tưởng tượng tình huống xấu nhất của phương án này xem, để cả nhóm biết trước mình đang đánh đổi cái gì.",
        "Khoan, lập luận này còn chỗ nào hổng không nhỉ... cho mình xem lại một chút.",
    ],
    "converging": [
        "Giờ so các phương án lại với nhau xem cái nào ổn nhất nhé, mình cần thêm chút thời gian.",
        "Để mình sắp các ý theo mức độ quan trọng, cho cả nhóm dễ quyết định hơn.",
        "Có điểm gì chung giữa mấy ý vừa nêu không nhỉ... thường chỗ giao nhau đó lại là hướng đáng chọn.",
        "Gom lại thành vài lựa chọn rõ ràng thôi, bàn tiếp trong quá nhiều nhánh thì rối lắm.",
        "Lựa chọn này ảnh hưởng tới cả phần còn lại của buổi đấy, mình cần cân nhắc kỹ thêm chút.",
    ],
    "wrap-up": [
        "Để mình tổng hợp lại cả hành trình hôm nay xem có bỏ sót kết luận nào không.",
        "Mình đang gom mấy điều cả nhóm thống nhất thành một bản tóm tắt gọn gàng.",
        "Điểm lại các quyết định chính đã nhé... cho mình vài giây sắp xếp cho mạch lạc.",
        "Còn việc gì mỗi người cần làm sau buổi này nhỉ, để mình chốt lại các bước tiếp theo.",
        "Được rồi, để mình viết lại phần kết luận cho rõ, đây là phần cả nhóm mang về sau buổi làm việc.",
    ],
}

# Must be kept in sync with VOICE_PRESETS in tts-sidecar/app.py — that file is the source of
# truth for what vieneu actually wants; this dict only mirrors its ids and kwargs.
VOICES = {
    "vi-female-01": {"voice": "Trúc Ly"},
    "vi-male-01": {"voice": "Phạm Tuyên"},
}


def _validate():
    expected_phases = ["framing", "diverging", "shifting", "critiquing", "converging", "wrap-up"]
    assert list(FILLER_TEXTS.keys()) == expected_phases, f"FILLER_TEXTS keys must equal PHASE_KEYS order, got {list(FILLER_TEXTS.keys())}"
    assert len(FILLER_TEXTS) == 6, f"expected 6 phases, got {len(FILLER_TEXTS)}"
    for phase, texts in FILLER_TEXTS.items():
        assert len(texts) == 5, f"phase {phase} must have exactly 5 phrases, got {len(texts)}"
    for voice_id in VOICES:
        assert "_" not in voice_id, f"voice id {voice_id!r} must not contain '_' (filler filenames use it as a field delimiter)"


def main():
    _validate()
    print("[fillers] loading VieNeu-TTS v3 Turbo...")
    tts = Vieneu(mode="v3turbo")  # loaded once, outside both loops
    rendered = 0
    skipped = 0
    # Voice is the OUTER loop so a per-voice checkpoint switch (if any) happens at most once.
    for voice_id, kwargs in VOICES.items():
        for phase, texts in FILLER_TEXTS.items():
            for i, text in enumerate(texts, start=1):
                out = HERE / f"filler_{phase}_{voice_id}_{i:02d}.wav"
                if out.exists() and not FORCE:
                    info = soundfile.info(out)
                    if info.duration >= MIN_DURATION_S:
                        print(f"[fillers] skip (ok): {out.name}")
                        skipped += 1
                        continue
                    print(f"[fillers] re-render (short/corrupt, {info.duration:.1f}s): {out.name}")
                wav = tts.infer(text, **kwargs)
                tts.save(wav, out)
                print(f"[fillers] wrote {out.name} <- \"{text}\"")
                rendered += 1
    total = rendered + skipped
    print(f"[fillers] done: {rendered} rendered, {skipped} skipped, {total} total.")
    if total != 60:
        print(f"[fillers] ERROR: expected 60 files, got {total}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
