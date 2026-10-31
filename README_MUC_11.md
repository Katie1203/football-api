# MỤC 11 – ĐỘ TIN CẬY TÍN HIỆU CẢNH BÁO AI LIVE RUNG

- Đây là **độ tin cậy của tín hiệu RUNG**, KHÔNG phải xác suất Poisson có thêm bàn thắng.
- Tính theo tỷ lệ WIN thực tế của ít nhất **30 tín hiệu đã FT**, cùng loại BET NHẸ TAY/BIG BET và cùng nhóm đặc trưng thị trường: số nhà cái đồng thuận, đồng thuận trong 5 phút, độ mạnh tăng mốc Tài.
- Chỉ sử dụng các tín hiệu có dữ liệu thị trường mới tại lúc phát cảnh báo. Hiển thị khoảng tin cậy Wilson 95%, số mẫu và số WIN qua API `signalConfidence`.
- Nếu chưa có ít nhất 30 tín hiệu FT tương đồng hoặc dữ liệu odds không mới, **hiển thị “—” thay vì phần trăm giả**.
- % được chụp và lưu vào bản ghi cảnh báo tại thời điểm gửi, không cập nhật lại sau FT; lịch sử tiếp tục được dùng cho tín hiệu MỚI.
- `live_rung_decision.js` và điều kiện Telegram được giữ nguyên; tính độ tin cậy độc lập, không tham gia quyết định phát cảnh báo.
- Đã nối API `/api/live-monitor`, `/api/no-stats-alerts`, `/api/rung-bet`, `/api/audit`, `/api/scan-history` với % đã lưu.

**Lưu ý:** 30 là cỡ mẫu tối thiểu để không đưa ra % từ quá ít lịch sử, không phải ngưỡng quyết định BET. Tỷ lệ WIN thực nghiệm chưa phải xác suất được hiệu chỉnh hoàn toàn; cần kiểm chứng trên dữ liệu ngoài mẫu trước khi coi là dự báo chuẩn xác.

**Cảnh báo:** Các vấn đề chưa xác minh LIVE thật của 10 mục vẫn tồn tại; chưa được chứng nhận production-ready.
