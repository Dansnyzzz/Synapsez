import { createShield } from './deidentify.js';

/**
 * What the mask catches, measured when the page asks (owner, 2026-11-08: "đo thật real-time,
 * trực tiếp"). Not a figure written down on the day it was taken: the samples below go
 * through the shield that is running now, so a change to it shows here at once. They
 * are samples written for the purpose, hard cases included, and say nothing about
 * anybody's own text: there is no answer key for that, so its catch rate cannot be
 * measured, only what was hidden in it counted (`maskedCounts` in the store).
 */

/** `[text, [[kind, value], ...]]`. No pairs: nothing in it may be hidden. */
export const CORPUS = Object.freeze([
  // ── email
  ['Gửi cho tôi qua lan.nguyen@example.com nhé', [['EMAIL', 'lan.nguyen@example.com']]],
  ['Contact: john.smith+work@mail.example.co.uk today', [['EMAIL', 'john.smith+work@mail.example.co.uk']]],
  ['email,name\nan.tran@cty.vn,An\nbinh@cty.vn,Binh', [['EMAIL', 'an.tran@cty.vn'], ['EMAIL', 'binh@cty.vn']]],
  ['Liên hệ HR@company.vn hoặc ceo@company.vn.', [['EMAIL', 'HR@company.vn'], ['EMAIL', 'ceo@company.vn']]],
  // ── phone
  ['Gọi 0912345678 sau 5 giờ', [['PHONE', '0912345678']]],
  ['SĐT: 0912 345 678', [['PHONE', '0912 345 678']]],
  ['số của tôi là +84 912 345 678', [['PHONE', '+84 912 345 678']]],
  ['Liên lạc 0084912345678.', [['PHONE', '0084912345678']]],
  ['Máy bàn - Điện thoại: 028 3822 1234', [['PHONE', '028 3822 1234']]],
  ['Call me on +1 415 555 2671 tomorrow', [['PHONE', '+1 415 555 2671']]],
  ['Hotline: 1900 6868 88', [['PHONE', '1900 6868 88']]],
  ['098.765.4321 là số của anh ấy', [['PHONE', '098.765.4321']]],
  // ── ids
  ['CCCD: 079123456789', [['ID', '079123456789']]],
  ['số căn cước công dân 079123456789 cấp năm 2021', [['ID', '079123456789']]],
  ['Mã định danh 001099012345 trong hồ sơ', [['ID', '001099012345']]],
  ['CMND số 271234567', [['ID', '271234567']]],
  ['Hộ chiếu: C1234567', [['ID', 'C1234567']]],
  ['Passport no. B98765432', [['ID', 'B98765432']]],
  ['Mã số thuế: 0312345678', [['ID', '0312345678']]],
  ['MST 0312345678-001 của công ty', [['ID', '0312345678-001']]],
  ['Sổ BHXH: 7912345678', [['ID', '7912345678']]],
  ['Thẻ BHYT số DN4797912345678', [['ID', 'DN4797912345678']]],
  ['SSN: 123-45-6789', [['ID', '123-45-6789']]],
  // ── accounts and cards
  ['STK: 0123456789 Vietcombank', [['ACCOUNT', '0123456789']]],
  ['số tài khoản 1903 4567 8901 23', [['ACCOUNT', '1903 4567 8901 23']]],
  ['Account number: 12345678901', [['ACCOUNT', '12345678901']]],
  ['thẻ 4111 1111 1111 1111 hết hạn 12/28', [['CARD', '4111 1111 1111 1111']]],
  ['card 5500-0000-0000-0004', [['CARD', '5500-0000-0000-0004']]],
  ['Thẻ Napas 9704 0000 0000 0018', [['CARD', '9704 0000 0000 0018']]],
  // ── names
  ['Tên tôi là Nguyễn Văn An', [['PERSON', 'Nguyễn Văn An']]],
  ['Họ và tên: Trần Thị Bình', [['PERSON', 'Trần Thị Bình']]],
  ['My name is John Smith and I work here', [['PERSON', 'John Smith']]],
  ['Người nhận: Lê Hoàng Nam', [['PERSON', 'Lê Hoàng Nam']]],
  ['Khách hàng: Phạm Minh Tuấn', [['PERSON', 'Phạm Minh Tuấn']]],
  ['Kính gửi Võ Thị Hồng,', [['PERSON', 'Võ Thị Hồng']]],
  ['Hôm qua anh Đặng Quốc Việt gọi lại', [['PERSON', 'Đặng Quốc Việt']]],
  ['Ông Bùi Văn Long đã ký', [['PERSON', 'Bùi Văn Long']]],
  ['Please ask Mr. David Brown first', [['PERSON', 'David Brown']]],
  ['Dear Maria Garcia, thanks', [['PERSON', 'Maria Garcia']]],
  ['Biên bản do Nguyễn Thị Thu Hà lập', [['PERSON', 'Nguyễn Thị Thu Hà']]],
  ['Hồ sơ của Huỳnh Tấn Phát Đạt đã xong', [['PERSON', 'Huỳnh Tấn Phát Đạt']]],
  // ── addresses
  ['Địa chỉ: 12 Nguyễn Trãi, Quận 1, TP.HCM', [['ADDRESS', '12 Nguyễn Trãi, Quận 1, TP.HCM']]],
  ['địa chỉ nhà: 45/7 đường Lê Lợi, phường Bến Nghé', [['ADDRESS', '45/7 đường Lê Lợi, phường Bến Nghé']]],
  ['Giao tới số 8 Lê Duẩn, Quận 3, TP.HCM nhé', [['ADDRESS', 'số 8 Lê Duẩn, Quận 3, TP.HCM']]],
  ['Shipping address: 221B Baker Street, London', [['ADDRESS', '221B Baker Street, London']]],
  ['Thường trú: xã Tân Phú, huyện Châu Thành, tỉnh Long An', [['ADDRESS', 'xã Tân Phú, huyện Châu Thành, tỉnh Long An']]],
  ['Address: 1600 Amphitheatre Parkway, Mountain View', [['ADDRESS', '1600 Amphitheatre Parkway, Mountain View']]],
  ['Địa chỉ: 12 Hàng Bài, Hà Nội, SĐT 0912345678', [['ADDRESS', '12 Hàng Bài, Hà Nội'], ['PHONE', '0912345678']]],
  // ── birth dates
  ['Ngày sinh: 12/03/1990', [['BIRTHDATE', '12/03/1990']]],
  ['sinh ngày 12 tháng 3 năm 1990 tại Huế', [['BIRTHDATE', '12 tháng 3 năm 1990']]],
  ['DOB: 1990-03-12', [['BIRTHDATE', '1990-03-12']]],
  ['Date of birth: March 12, 1990', [['BIRTHDATE', 'March 12, 1990']]],
  ['born on 12 March 1990', [['BIRTHDATE', '12 March 1990']]],
  // ── plates
  ['Biển số xe: 51F-123.45', [['PLATE', '51F-123.45']]],
  ['xe 30A-12345 đỗ ở đây', [['PLATE', '30A-12345']]],
  ['BKS 29B1-123.45', [['PLATE', '29B1-123.45']]],
  ['Xe máy 59-X1 123.45 của tôi', [['PLATE', '59-X1 123.45']]],
  // ── network
  ['server tại 203.0.113.42 bị chặn', [['IP', '203.0.113.42']]],
  ['IP address: 192.168.1.10', [['IP', '192.168.1.10']]],
  ['from 2001:db8:85a3::8a2e:370:7334 yesterday', [['IP', '2001:db8:85a3::8a2e:370:7334']]],
  ['fe80:0:0:0:200:f8ff:fe21:67cf là địa chỉ', [['IP', 'fe80:0:0:0:200:f8ff:fe21:67cf']]],
  // ── secrets
  ['khoá của tôi sk-or-v1-abcdefghijklmnopqrstuvwxyz012345', [['SECRET', 'sk-or-v1-abcdefghijklmnopqrstuvwxyz012345']]],
  ['AKIAIOSFODNN7EXAMPLE là access key', [['SECRET', 'AKIAIOSFODNN7EXAMPLE']]],
  ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', [['SECRET', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']]],
  ['mở https://x.example/reset?token=abc123XYZ789&lang=vi', [['SECRET', 'abc123XYZ789']]],
  ['https://x.example/a?page=2&api_key=q1w2e3r4t5', [['SECRET', 'q1w2e3r4t5']]],
  ['Mật khẩu: hunter2024', [['SECRET', 'hunter2024']]],
  ['DB_PASSWORD=sup3rs3cret', [['SECRET', 'sup3rs3cret']]],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', [['SECRET', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U']]],
  // ── written the way a Mac writes it
  ['Ngày sinh: 12/03/1990'.normalize('NFD'), [['BIRTHDATE', '12/03/1990']]],
  ['Họ và tên: Trần Thị Bình'.normalize('NFD'), [['PERSON', 'Trần Thị Bình']]],

  // ── harder, and left in whether they pass or not. A corpus written beside the detectors
  // passes itself; these are what somebody really writes, and the misses are what the page
  // has to admit. Do not delete one to make a figure look better.
  ['liên hệ lan[at]example.com nhé', [['EMAIL', 'lan[at]example.com']]],
  ['gọi số 09 12 34 56 78 nha', [['PHONE', '09 12 34 56 78']]],
  ['0912-345-678 là của chị ấy', [['PHONE', '0912-345-678']]],
  ['văn phòng (028) 3822 1234 giờ hành chính', [['PHONE', '(028) 3822 1234']]],
  ['số chứng minh của nó là 271234567 đó', [['ID', '271234567']]],
  ['CCCD 079 123 456 789', [['ID', '079 123 456 789']]],
  ['chuyển vào TK 0123456789 giúp', [['ACCOUNT', '0123456789']]],
  ['số tk: 0123456789', [['ACCOUNT', '0123456789']]],
  ['thẻ của tôi 4111111111111111', [['CARD', '4111111111111111']]],
  ['nhờ Minh gửi giúp tôi', [['PERSON', 'Minh']]],
  ['Nguyễn An sẽ đến lúc 3 giờ', [['PERSON', 'Nguyễn An']]],
  ['Then Sarah Connor called the office', [['PERSON', 'Sarah Connor']]],
  ['Bác sĩ Trần Văn Minh khám hôm nay', [['PERSON', 'Trần Văn Minh']]],
  ['Nhà tôi ở 12 Hàng Bài Hà Nội', [['ADDRESS', '12 Hàng Bài Hà Nội']]],
  ['tôi ở gần chợ Bến Thành, cạnh tiệm vàng', [['ADDRESS', 'gần chợ Bến Thành, cạnh tiệm vàng']]],
  ['Lô 5 khu công nghiệp Tân Bình, Quận Tân Phú', [['ADDRESS', 'Lô 5 khu công nghiệp Tân Bình, Quận Tân Phú']]],
  ['tôi sinh 12/3/90 ở Huế', [['BIRTHDATE', '12/3/90']]],
  ['xe tôi 51F12345 màu đỏ', [['PLATE', '51F12345']]],
  ['ping 192.168.001.010 không được', [['IP', '192.168.001.010']]],
  ['pass: hunter2024 nhé', [['SECRET', 'hunter2024']]],
  ['token là abc123XYZ789 đó', [['SECRET', 'abc123XYZ789']]],
  // Looks personal and is not: these come back as false alarms, and that is the honest figure too.
  ['Linh kiện 30A-1234 đã về kho', []],
  ['Công ty Trần Anh Group mở bán', []],
  ['Trung tâm Hồ Gươm Plaza khai trương', []],
  ['Máy chủ 10.20.30.40 chỉ là ví dụ trong tài liệu', []],

  // ── nothing personal: every one of these was once somebody's false alarm, or could be
  ['Timestamp 1730851200000 trong log', []],
  ['Giá trị là 0.912345678 sau khi chuẩn hoá', []],
  ['Mã đơn hàng ORD-2026-000123 đã giao', []],
  ['Doanh thu 1,234,567,890 đồng trong quý 3', []],
  ['Chrome/120.0.0.0 Safari/537.36', []],
  ['phiên bản 1.2.3.4 đã ra mắt', []],
  ['listen on 127.0.0.1 and 0.0.0.0', []],
  ['Lúc 12:30:45 ngày 12/03/2026 hệ thống khởi động', []],
  ['Máy có 16GB 3200MHz, ổ A4-1234', []],
  ['std::vector<int> v; a::b();', []],
  ['Đường Trần Hưng Đạo dài 3 km', []],
  ['Thành phố Hồ Chí Minh có 22 quận huyện', []],
  ['Tỉnh Bà Rịa Vũng Tàu giáp biển', []],
  ['Lớp Anh Văn Cơ Bản khai giảng', []],
  ['Kính gửi Quý khách hàng,', []],
  ['max token: 4096, temperature: 0.7', []],
  ['Xem https://example.com/a?page=2&sort=asc', []],
  ['Sản phẩm 12 Pro Max, Quận cam không liên quan', []],
  ['The server address: is unknown', []],
  ['Nguyễn Trãi là nhà thơ lớn', []],
  ['ISBN 978-3-16-148410-0 của sách', []],
  ['Chỉ số 4111 trong bảng, không phải thẻ', []],
  ['hash 5d41402abc4b2a76b9719d911017c592', []],
  ['Tỷ lệ 45.5% năm 2025, tăng 3.2 điểm', []],
  ['Hội nghị 15-11-2026 tại Hà Nội', []],
]);

/** One sample's hits and misses against what a shield hid. */
function score(text, expected) {
  const shield = createShield({ key: 'measure' });
  const masked = shield.maskText(text);
  const hidden = [];
  for (const match of masked.matchAll(/<([A-Z]+)_[0-9a-fx]+>/g)) hidden.push({ kind: match[1], value: shield.restoreText(match[0]) });
  return { hidden, expected: expected.map(([kind, value]) => ({ kind, value })) };
}

/** Same characters whichever way they were written, and the spaces do not matter. */
const same = (a, b) => a.normalize('NFC').replace(/\s+/g, ' ').trim() === b.normalize('NFC').replace(/\s+/g, ' ').trim();
const rounded = (n) => Math.round(n * 1000) / 1000;

/**
 * The figures, and what each sample got wrong, from the shield as it is now.
 *
 * @returns {{ measuredAt: string, samples: number, clean: number, kinds: Record<string, { samples: number, recall: number, precision: number }>, problems: string[] }}
 */
export function measureMasking() {
  const tally = {};
  const row = (kind) => (tally[kind] ??= { found: 0, missed: 0, wrong: 0, samples: 0 });
  const problems = [];
  for (const [text, wanted] of CORPUS) {
    const { hidden, expected } = score(text, wanted);
    const left = [...hidden];
    for (const want of expected) {
      row(want.kind).samples += 1;
      const at = left.findIndex((h) => h.kind === want.kind && same(h.value, want.value));
      if (at >= 0) {
        row(want.kind).found += 1;
        left.splice(at, 1);
      } else {
        row(want.kind).missed += 1;
        problems.push(`missed ${want.kind} "${want.value}" in "${text}"`);
      }
    }
    for (const extra of left) {
      row(extra.kind).wrong += 1;
      problems.push(`hid ${extra.kind} "${extra.value}" in "${text}"`);
    }
  }
  const kinds = Object.fromEntries(
    Object.entries(tally)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, { found, missed, wrong, samples }]) => [kind, { samples, recall: rounded(found / Math.max(1, found + missed)), precision: rounded(found / Math.max(1, found + wrong)) }]),
  );
  return { measuredAt: new Date().toISOString(), samples: CORPUS.length, clean: CORPUS.filter(([, wanted]) => !wanted.length).length, kinds, problems };
}

let last = null;
/** The same, measured again at most every ten minutes: it is the same code until a deployment. */
export function currentMasking(now = Date.now()) {
  if (!last || now - Date.parse(last.measuredAt) > 10 * 60_000) last = measureMasking();
  return last;
}
