/**
 * Script Test: test-semester.js
 * Chạy bằng lệnh: node test-semester.js
 */

// 1. Dữ liệu mốc (Mock Data) từ API bạn cung cấp
const mockApiData = [
  {
    "semester": "20252",
    "startDate": 1771779600000, // Tương đương: 23/02/2026
    "endDate": 1784394000000,   // Tương đương: 19/07/2026
    "startWeek": 25,
    "currentWeek": 10,
    "absoluteCurrentWeek": 34,
    "id": "20252"
  },
  {
    "semester": "20253",
    "startDate": 1784480400000, 
    "endDate": 1788454800000,
    "startWeek": 0,
    "currentWeek": 0,
    "absoluteCurrentWeek": -1,
    "id": "20253"
  }
];

// 2. Hàm chứa Core Logic (Copy y hệt từ Service sang để test)
function calculateSemesterData(mockNowMs) {
  // Lọc các kỳ có absoluteCurrentWeek != -1 và sort giảm dần
  const validSemesters = mockApiData.filter(s => s.absoluteCurrentWeek !== -1);
  validSemesters.sort((a, b) => b.semester.localeCompare(a.semester));
  
  const currentSem = validSemesters[0];
  if (!currentSem) return null;

  const startMs = currentSem.startDate;
  
  // Tính số ngày chênh lệch
  const diffInDays = Math.floor((mockNowMs - startMs) / 86400000);
  
  // Tính tuần
  let calculatedCurrentWeek = Math.floor(diffInDays / 7) + 1;
  if (calculatedCurrentWeek < 1) calculatedCurrentWeek = 1; // Nếu chưa khai giảng, coi như đang ở Tuần 1

  const calculatedAbsoluteWeek = currentSem.startWeek + calculatedCurrentWeek - 1;

  return {
    kỳ_học: currentSem.semester,
    ngày_bắt_đầu: new Date(currentSem.startDate).toLocaleDateString('vi-VN'),
    ngày_kết_thúc: new Date(currentSem.endDate).toLocaleDateString('vi-VN'),
    tuần_hiện_tại: calculatedCurrentWeek,
    tuần_tuyệt_đối: calculatedAbsoluteWeek,
    chênh_lệch_ngày: diffInDays
  };
}

// 3. CHẠY CÁC KỊCH BẢN TEST (Test Cases)
console.log("==================================================");
console.log("🧪 BẮT ĐẦU TEST LOGIC TÍNH TOÁN TUẦN HỌC HUSTVA");
console.log("==================================================\n");

// Test Case 1: Đúng ngày khai giảng (Thứ 2, 23/02/2026)
const testDate1 = new Date("2026-02-23T08:00:00").getTime();
console.log("▶️ Test Case 1: Đúng ngày khai giảng (23/02/2026)");
console.log(calculateSemesterData(testDate1));
console.log("--------------------------------------------------");

// Test Case 2: Giữa tuần thứ 2 (Thứ 5, 05/03/2026)
const testDate2 = new Date("2026-03-05T08:00:00").getTime();
console.log("▶️ Test Case 2: Sang giữa tuần thứ 2 (05/03/2026)");
console.log(calculateSemesterData(testDate2));
console.log("--------------------------------------------------");

// Test Case 3: Ngày hiện tại lúc bạn hỏi tôi (05/05/2026)
const testDate3 = new Date("2026-05-05T08:00:00").getTime();
console.log("▶️ Test Case 3: Ngày test thực tế (05/05/2026)");
console.log(calculateSemesterData(testDate3));
console.log("--------------------------------------------------");

// Test Case 4: Trước ngày khai giảng 1 tuần (16/02/2026) -> Kì vọng vẫn báo là tuần 1
const testDate4 = new Date("2026-02-16T08:00:00").getTime();
console.log("▶️ Test Case 4: Trước ngày khai giảng 1 tuần (16/02/2026)");
console.log(calculateSemesterData(testDate4));
console.log("==================================================");