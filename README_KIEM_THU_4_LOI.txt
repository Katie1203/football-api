THAN TAI MAY MAN - BONGDALU - BAN KIEM THU, CHUA XAC NHAN DEPLOY
Nguon: THAN_TAI_FIX_ODDS_22_5S_AUDIT_PHUT_20261031(1).zip (index.js)
Giao dien doi chieu: ban Render nguon 2, chi lay bo cuc live-monitor.html.

Da sua:
1. matchTime/matchTime2 string theo gio VN; xac minh phut LIVE, uu tien odds LIVE hop le.
2. Lay HomeHalfScore/GuestHalfScore tu diary de xac minh ban thang HT.
3. Odds companyid=2 (BET365 theo yeu cau); luu snapshot 5s co san, kiem tra freshness provider_time.
4. live-monitor.html khong ghi de lambda, odds, nhan alert bang null khi API co gia tri.

Kiem thu: node --check index.js; node test_bongdalu_patch.js; node --check script giao dien.
Chua xac minh: HTTP proxy LIVE thuc te tren Render; toan bo luong AI/Telegram/FT; tinh tuong thich giao dien voi cac API server.
CANH BAO: day la ban kiem thu, KHONG KHUYEN NGHI DEPLOY production truoc khi kiem thu tich hop.
Chi ghi de index.js va live-monitor.html neu cac tep phu thuoc cua du an goc da co.
