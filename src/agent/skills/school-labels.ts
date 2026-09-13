/**
 * HUST school / faculty labels cho Retrieval Gateway.
 *
 * Mỗi trường/khoa trong HUST có một "label" (mã) riêng. Khi search RAG, ngoài
 * các tài liệu CHUNG (luôn gắn nhãn 'all' và LUÔN được tìm tới ở phía Gateway),
 * ta có thể bổ sung thêm tài liệu RIÊNG của từng trường/khoa bằng cách truyền
 * mảng `labels` sang Gateway.
 *
 * Known labels (ràng buộc của Gateway):
 *   ['act', 'fami', 'fed', 'scls', 'seee', 'sem', 'sme', 'smse', 'sofl', 'soict', 'sep']
 * Nhãn 'all' là mặc định phía Gateway nên KHÔNG cần (và không nên) truyền vào.
 */

export const KNOWN_LABELS = [
    'act', 'fami', 'fed', 'scls', 'seee',
    'sem', 'sme', 'smse', 'sofl', 'soict', 'sep',
] as const;

export type SchoolLabel = (typeof KNOWN_LABELS)[number];

const KNOWN_LABEL_SET: Set<string> = new Set(KNOWN_LABELS);

/** Bỏ dấu tiếng Việt, hạ thường, chuẩn hoá gạch ngang & khoảng trắng. */
function normalizeVi(input: string): string {
    return (input || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // bỏ dấu thanh (sắc, huyền, hỏi...)
        .replace(/đ/g, 'd')
        .replace(/[-–—]/g, ' ') // mọi loại gạch ngang -> khoảng trắng
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Bảng ánh xạ TÊN trường/khoa (đã chuẩn hoá) -> label code.
 * Tên gốc lấy từ `student_context.school` (eHUST trả về TÊN đầy đủ, không phải mã).
 */
const SCHOOL_NAME_TO_LABEL: Record<string, SchoolLabel> = {
    [normalizeVi('Trường Công nghệ Thông tin và Truyền thông')]: 'soict',
    [normalizeVi('Trường Hóa và Khoa học sự sống')]: 'scls',
    [normalizeVi('Trường Điện - Điện tử')]: 'seee',
    [normalizeVi('Khoa Vật lý kỹ thuật')]: 'sep',
    [normalizeVi('Khoa Toán - Tin')]: 'fami',
    [normalizeVi('Khoa Ngoại ngữ')]: 'sofl',
    [normalizeVi('Trường Cơ khí')]: 'sme',
    [normalizeVi('Trường Vật liệu')]: 'smse',
    [normalizeVi('Khoa Khoa học và Công nghệ giáo dục')]: 'fed',
    [normalizeVi('Khoa Khoa học Giáo dục')]: 'fed', // alias đề phòng tên rút gọn
    [normalizeVi('Trường Kinh tế')]: 'sem',
};

/**
 * Đổi TÊN trường/khoa của sinh viên (`student_context.school`) -> label code.
 * Trả về null nếu không khớp (sinh viên ẩn danh, tên lạ...).
 */
export function resolveSchoolLabel(schoolName?: string | null): SchoolLabel | null {
    if (!schoolName) return null;
    const key = normalizeVi(schoolName);
    if (!key) return null;

    // 1) Khớp chính xác sau khi chuẩn hoá
    if (SCHOOL_NAME_TO_LABEL[key]) return SCHOOL_NAME_TO_LABEL[key];

    // 2) Khớp lỏng: phòng trường hợp eHUST thêm hậu tố/tiền tố vào tên
    for (const [name, label] of Object.entries(SCHOOL_NAME_TO_LABEL)) {
        if (key.includes(name) || name.includes(key)) return label;
    }
    return null;
}

/**
 * Nhãn 'all' của Gateway: tài liệu CHUNG của toàn trường.
 * Gateway luôn kèm 'all' vào filter (`label in [...requested, 'all']`).
 */
export const GATEWAY_ALL_LABEL = 'all';

/**
 * Các nhãn CHƯA được đăng ký trong `allowed_labels` của KB trên Gateway.
 * Gửi nhãn lạ -> Gateway trả HTTP 400 -> policy_search chết âm thầm -> câu trả
 * lời mất căn cứ tài liệu. Nên ta hạ chúng về 'all' (chỉ tra tài liệu chung).
 *
 * 'sep' (Khoa Vật lý Kỹ thuật): KB hiện CHƯA có tài liệu riêng của khoa này,
 * nên không có nhãn 'sep' trong allowed_labels. Khi nào KB nạp tài liệu riêng
 * cho SEP thì XOÁ dòng dưới đây là chạy ngay, không cần sửa gì thêm.
 */
const UNREGISTERED_LABEL_FALLBACK: Record<string, string> = {
    sep: GATEWAY_ALL_LABEL,
};

/**
 * Đổi danh sách nhãn nội bộ -> nhãn gửi được cho Gateway.
 * Nhãn nào chưa đăng ký thì hạ về 'all'; loại trùng lặp.
 */
export function toGatewayLabels(labels: SchoolLabel[]): string[] {
    const out: string[] = [];
    for (const l of labels) {
        const mapped = UNREGISTERED_LABEL_FALLBACK[l] ?? l;
        if (!out.includes(mapped)) out.push(mapped);
    }
    return out;
}

/** Chỉ giữ các nhãn hợp lệ (thuộc KNOWN_LABELS), loại trùng lặp & giá trị rỗng. */
export function sanitizeLabels(labels?: Array<string | null | undefined>): SchoolLabel[] {
    if (!labels?.length) return [];
    const out: SchoolLabel[] = [];
    for (const raw of labels) {
        const l = (raw || '').trim().toLowerCase();
        if (KNOWN_LABEL_SET.has(l) && !out.includes(l as SchoolLabel)) {
            out.push(l as SchoolLabel);
        }
    }
    return out;
}
