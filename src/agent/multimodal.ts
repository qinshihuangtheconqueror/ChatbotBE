/**
 * multimodal.ts — xử lý ảnh sinh viên đính kèm vào câu hỏi.
 *
 * Chuyển thể từ bản E-learning (`Elearning-langgraph/.../multimodal.ts`), nhưng
 * đổi 3 điểm cho phù hợp HustVA:
 *
 * 1. CHỈ nhận data-URI, KHÔNG nhận URL http(s) do client gửi.
 *    Bản gốc `loadImageBytes()` fetch bất kỳ URL nào client đưa lên -> client có
 *    thể ép server gọi vào mạng nội bộ (SSRF: 127.0.0.1, 169.254.169.254,
 *    mongodb/redis trong docker network...). E-learning chấp nhận được vì URL do
 *    chính hệ thống của họ sinh ra; HustVA nhận thẳng từ trình duyệt sinh viên
 *    nên phải chặn.
 *
 * 2. KHÔNG nén ở server. Bản gốc dùng `sharp` (thư viện native, ~30MB, phải build
 *    trong Docker). HustVA có frontend thật nên nén bằng canvas ngay trên trình
 *    duyệt trước khi gửi — nhẹ hơn, và giảm luôn băng thông.
 *
 * 3. KHÔNG lưu ảnh vào DB. Ảnh chỉ dùng cho LƯỢT HỎI HIỆN TẠI; lịch sử chỉ ghi
 *    dấu "[đã gửi N ảnh]". Lưu base64 vào Mongo sẽ phình ổ cứng rất nhanh.
 *    Khi nào có S3/MinIO thì nối thêm bước upload rồi lưu URL.
 */
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('Multimodal');

const DATA_URI_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s;

/** Định dạng model đọc được. */
const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);

/** Trần an toàn — frontend đã nén trước, đây chỉ là lưới chắn. */
export const MAX_IMAGES_PER_TURN = 5;
export const MAX_IMAGE_BYTES = 4_000_000;      // 4MB mỗi ảnh sau khi giải base64
export const MAX_TOTAL_IMAGE_BYTES = 12_000_000;

/**
 * Chữ ký nhận dạng file thật (magic bytes). Không tin phần khai báo mime trong
 * data-URI: client có thể ghi `data:image/png` nhưng nhét nội dung bất kỳ.
 */
function sniffFormat(bytes: Buffer): string | null {
    if (bytes.length < 12) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
}

export interface ImagePart {
    type: 'image_url';
    image_url: { url: string };
}
export interface TextPart {
    type: 'text';
    text: string;
}
export type ContentPart = TextPart | ImagePart;

export interface SanitizeResult {
    /** data-URI đã được kiểm tra, sẵn sàng gửi cho model. */
    images: string[];
    /** Số ảnh bị loại và lý do — để log, không trả cho người dùng. */
    rejected: Array<{ index: number; reason: string }>;
}

/**
 * Lọc danh sách ảnh do client gửi lên.
 * Ảnh hỏng bị bỏ RIÊNG LẺ — một ảnh lỗi không được làm hỏng cả câu hỏi.
 */
export function sanitizeImages(refs: unknown): SanitizeResult {
    const out: string[] = [];
    const rejected: Array<{ index: number; reason: string }> = [];

    if (!Array.isArray(refs) || refs.length === 0) {
        return { images: out, rejected };
    }

    let total = 0;

    for (let i = 0; i < refs.length; i++) {
        if (out.length >= MAX_IMAGES_PER_TURN) {
            rejected.push({ index: i, reason: `vượt quá ${MAX_IMAGES_PER_TURN} ảnh` });
            continue;
        }

        const ref = refs[i];
        if (typeof ref !== 'string' || !ref.trim()) {
            rejected.push({ index: i, reason: 'không phải chuỗi' });
            continue;
        }

        const trimmed = ref.trim();

        // Chặn SSRF: chỉ chấp nhận data-URI, tuyệt đối không fetch URL từ client.
        const m = DATA_URI_RE.exec(trimmed);
        if (!m) {
            rejected.push({
                index: i,
                reason: trimmed.startsWith('http') ? 'URL bị từ chối (chỉ nhận data-URI)' : 'không phải data-URI ảnh',
            });
            continue;
        }

        let bytes: Buffer;
        try {
            bytes = Buffer.from(m[2] ?? '', 'base64');
        } catch {
            rejected.push({ index: i, reason: 'base64 hỏng' });
            continue;
        }

        if (!bytes.length) {
            rejected.push({ index: i, reason: 'rỗng' });
            continue;
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
            rejected.push({ index: i, reason: `quá lớn (${(bytes.length / 1e6).toFixed(1)}MB)` });
            continue;
        }

        // Kiểm tra nội dung thật, không tin mime client khai.
        const real = sniffFormat(bytes);
        if (!real || !SUPPORTED_FORMATS.has(real)) {
            rejected.push({ index: i, reason: 'không phải ảnh hợp lệ (png/jpeg/gif/webp)' });
            continue;
        }

        total += bytes.length;
        if (total > MAX_TOTAL_IMAGE_BYTES) {
            rejected.push({ index: i, reason: 'vượt tổng dung lượng cho phép' });
            continue;
        }

        // Dựng lại data-URI theo định dạng THẬT, bỏ phần client khai.
        out.push(`data:image/${real};base64,${bytes.toString('base64')}`);
    }

    if (rejected.length) {
        logger.warn('Có ảnh bị loại', { nhận: out.length, loại: rejected });
    }
    return { images: out, rejected };
}

/**
 * Dựng nội dung đa phương thức cho một lượt hỏi.
 * Trả về `undefined` khi không có ảnh hợp lệ, để nhánh chỉ-văn-bản giữ nguyên.
 */
export function buildMultimodalContent(text: string, images: string[] | undefined): ContentPart[] | undefined {
    if (!images?.length) return undefined;
    const parts: ContentPart[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const url of images) parts.push({ type: 'image_url', image_url: { url } });
    return parts;
}

/** Dấu hiệu ghi vào lịch sử thay cho ảnh (không lưu bytes xuống DB). */
export function imageHistoryMarker(count: number): string {
    return count > 0 ? `\n\n_[sinh viên đã gửi kèm ${count} ảnh]_` : '';
}
