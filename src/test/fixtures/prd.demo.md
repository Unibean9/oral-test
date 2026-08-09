# PRD: Kể Chuyện Tối Nay

## 1. Vấn đề (Problem Statement)
Trẻ nhỏ 3-6 tuổi thường quấy khóc, không chịu đọc sách giấy trước giờ đi ngủ và đòi xem điện thoại thay vào đó. Nguyên nhân được xác định gồm hai điểm nghẽn: sách giấy đang thua kém điện thoại về độ hấp dẫn (thiếu âm thanh, thiếu tương tác), và gia đình chưa có một nghi thức (ritual) rõ ràng trước giờ ngủ, khiến điện thoại trở thành lựa chọn dễ nhất cho cả con lẫn ba mẹ. Vấn đề này đáng giải quyết vì nó ảnh hưởng trực tiếp đến thói quen đọc sách và giấc ngủ của trẻ, đồng thời tạo xung đột lặp lại mỗi tối giữa ba mẹ và con.

## 2. Đối tượng người dùng (Target Audience)
Phụ huynh có con nhỏ trong độ tuổi 3-6, đang gặp khó khăn ở thời điểm trước giờ ngủ: con quấy khóc khi được yêu cầu đọc sách giấy, và có xu hướng đòi xem điện thoại thay thế.

## 3. Kịch bản sử dụng (User Stories & Scenarios)
[Giả định] Buổi tối, một phụ huynh chuẩn bị cho con đi ngủ và đưa sách giấy ra như thường lệ. Con phản ứng bằng cách quấy khóc và đòi điện thoại, vì với con, sách giấy không mang lại cảm giác hồi hộp "muốn biết điều gì xảy ra tiếp theo" như khi xem video, và việc đọc một mình (hoặc bị bắt tự đọc) không hấp dẫn bằng được ba mẹ cùng nhập vai. Khi ba mẹ chuyển sang nhập vai các nhân vật trong truyện và kể cùng con thay vì chỉ đọc chữ, con tham gia hào hứng hơn, và giờ đọc sách dần trở thành một nghi thức được mong chờ mỗi tối thay vì một cuộc giằng co để giành lấy điện thoại.

## 4. Giải pháp đề xuất (Proposed Solution)
Trọng tâm giải pháp là xây dựng một nghi thức đọc sách trước giờ ngủ mà ba mẹ cùng nhập vai kể chuyện với con, thay vì tập trung vào thiết bị hay phụ kiện đắt tiền. Nhóm ban đầu đề xuất nhiều hướng thiên về phần cứng — kệ sách gắn loa phát tiếng động vật, đèn ngủ đổi màu theo từng chương truyện, bảng sticker thưởng sau mỗi cuốn sách đọc xong, và mô hình hộp thuê bao (subscription box) gửi sách kèm phụ kiện hàng tháng. Sau khi xét từ góc nhìn của chính đứa trẻ, nhóm nhận ra insight quan trọng: con không cần thiết bị xịn đẹp, con cần cảm giác hồi hộp và được ba mẹ nhập vai cùng, không phải tự đọc một mình. Vì vậy các hướng thiết bị/mua sắm (kệ sách loa, đèn ngủ, subscription box) bị lùi ưu tiên, còn hướng nhập vai kể chuyện — không cần mua thêm gì, chỉ cần kịch bản gợi ý trong sách — được chọn làm trọng tâm vì giải quyết đúng gốc rễ (thiếu tương tác, thiếu nghi thức) với chi phí và rủi ro thấp nhất.

## 5. Tính năng chính (Key Features)

### 5.1 Nhập vai kể chuyện
- **Là gì:** Kịch bản gợi ý in kèm trong sách để ba mẹ và con cùng nhập vai các nhân vật, con được tự kể lại bằng giọng của mình.
- **Vì sao:** Giải quyết trực tiếp cả hai điểm nghẽn ở mục 1 — thêm tương tác/cảm giác hồi hộp mà sách giấy đang thiếu, và tạo ra nghi thức trước giờ ngủ mà gia đình chưa có, không cần mua thêm phụ kiện.
- **Ưu tiên:** P0

### 5.2 Đèn ngủ đổi màu theo chương truyện
- **Là gì:** Đèn ngủ đổi màu tương ứng với từng chương/đoạn trong truyện đang đọc.
- **Vì sao:** Tăng thêm tác động cảm xúc và không khí cho nghi thức đọc sách, nhưng cần phần cứng đơn giản nên triển khai sau tính năng nhập vai.
- **Ưu tiên:** P1

### 5.3 Kệ sách gắn loa phát tiếng động vật
- **Là gì:** Kệ sách tích hợp loa nhỏ, phát tiếng động vật khi mở đúng trang/sách.
- **Vì sao:** Bổ sung yếu tố âm thanh còn thiếu ở sách giấy, nhưng nhóm đánh giá chi phí cao và rủi ro lớn hơn so với nhập vai kể chuyện nên xếp sau.
- **Ưu tiên:** P2

### 5.4 Subscription box (hộp thuê bao sách + phụ kiện hàng tháng)
- **Là gì:** Mô hình gửi sách kèm phụ kiện định kỳ hàng tháng, thay vì bán đứt một lần.
- **Vì sao:** Có thể duy trì nguồn sách mới liên tục, nhưng nhóm xác định rủi ro cao (dễ bị xem như đồ chơi dùng vài tháng rồi bỏ, phụ thuộc thời gian ba mẹ mỗi tối, chi phí hộp tháng cao hơn mua sách lẻ) nên xếp ưu tiên thấp.
- **Ưu tiên:** P2

### 5.5 Bảng sticker sau mỗi cuốn sách
- **Là gì:** Bảng dán sticker thưởng cho con sau khi đọc xong một cuốn sách.
- **Vì sao:** Nhóm đánh giá tính năng này ít tác động tới vấn đề gốc (thiếu tương tác/thiếu nghi thức) và có thể bỏ qua.
- **Ưu tiên:** P2 (nhóm đề xuất có thể bỏ qua)

## 6. Phạm vi (Scope: In / Out)
[Giả định] Dựa trên thứ tự ưu tiên nhóm đã chốt, phạm vi bản đầu tiên (V1) đề xuất như sau:
- **Trong phạm vi (In):** Nhập vai kể chuyện (kịch bản gợi ý trong sách).
- **Cân nhắc cho giai đoạn sau (In, phase 2):** Đèn ngủ đổi màu theo chương truyện.
- **Ngoài phạm vi ban đầu (Out):** Kệ sách gắn loa, subscription box (chi phí và rủi ro cao, cần đánh giá thêm trước khi triển khai).
- **Loại bỏ (Out):** Bảng sticker — nhóm đánh giá ít tác động, có thể bỏ qua.

## 7. Khác biệt & Rủi ro (Differentiation & Risks)
Khác biệt cốt lõi so với các sản phẩm thiết bị/phụ kiện đọc sách khác là giải pháp không đặt trọng tâm vào phần cứng hay màn hình ("Kindle cho trẻ con nhưng không có màn hình" là cách nhóm tự mô tả các ý tưởng ban đầu), mà đặt trọng tâm vào khoảnh khắc ba mẹ trực tiếp nhập vai cùng con mỗi tối.

Rủi ro chính mà nhóm xác định (áp dụng rõ nhất cho hướng mở rộng subscription box, nhưng cũng liên quan đến việc duy trì nghi thức nói chung):
- Phụ huynh có thể thấy sản phẩm/nghi thức giống một món đồ chơi mới, dùng vài tháng rồi bỏ xó.
- Ba mẹ quá bận, không có thời gian nhập vai mỗi tối, khiến chương trình bị bỏ dở — đây là điểm nhóm xác định có thể là "điểm chết" của cả ý tưởng nếu không thiết kế đơn giản.
- Với mô hình hộp thuê bao, chi phí hàng tháng có thể cao hơn so với mua sách lẻ.

## 8. Chỉ số thành công (Success Metrics)
[Giả định] Nhóm chưa thảo luận số liệu hay chỉ tiêu cụ thể. Dựa trên vấn đề và insight đã nêu, các chỉ số định tính có thể cân nhắc để đánh giá thành công gồm: tần suất gia đình duy trì nghi thức nhập vai kể chuyện mỗi tối trong một khoảng thời gian liên tục, mức độ giảm quấy khóc/giằng co đòi điện thoại trước giờ ngủ theo quan sát của phụ huynh, và mức độ ba mẹ cảm thấy kịch bản gợi ý trong sách dễ dùng, không tốn thêm thời gian chuẩn bị.

## 9. Giả định & Câu hỏi mở (Assumptions & Open Questions)
- [Giả định] §3 (Kịch bản sử dụng): kịch bản cụ thể được dựng lại dựa trên insight nhóm nêu ở turn 5 (con muốn ba mẹ nhập vai cùng, muốn cảm giác hồi hộp) và vấn đề gốc ở turn 1/3 — nhóm không mô tả một tình huống theo trình tự thời gian cụ thể.
- [Giả định] §6 (Phạm vi In/Out): việc chia giai đoạn V1/phase 2/loại bỏ được suy ra trực tiếp từ thứ tự ưu tiên nhóm chốt ở turn 7; nhóm không dùng khung "in scope/out of scope" khi thảo luận.
- [Giả định] §8 (Chỉ số thành công): nhóm không thảo luận chỉ số đo lường; các chỉ số định tính nêu trên được suy ra từ vấn đề và tính năng đã thống nhất, không phải số liệu do nhóm cung cấp.
- Tiêu đề tài liệu dùng đúng tên nhóm tự đặt ở turn 8: "Kể Chuyện Tối Nay".
- Thứ tự ưu tiên P0/P1/P2 ở mục 5 và 6 lấy trực tiếp từ xếp hạng bằng Impact-Effort Matrix mà nhóm đã chốt (turn 7), không phải do người viết tài liệu tự đánh giá lại.
- Câu hỏi mở: nhóm chưa nói rõ hình thức cụ thể của "kịch bản gợi ý trong sách" (in sẵn trong sách vật lý, hay tài liệu/app đi kèm) — cần làm rõ trước khi thiết kế chi tiết.
- Câu hỏi mở: nhóm chưa thảo luận mô hình kinh doanh cho tính năng P0 (nhập vai kể chuyện) — subscription box chỉ được đề xuất cho việc gửi sách/phụ kiện định kỳ, chưa rõ có áp dụng cho sách có kịch bản nhập vai hay không.
