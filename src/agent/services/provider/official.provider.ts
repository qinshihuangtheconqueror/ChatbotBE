import { EHustDbApiClient } from '@/agent/tools/clients/ehust-db.client';
import { TranscriptProvider } from '../transcript.provider';
import { createLogger } from '@/common/logger/logger';

const logger = createLogger('OfficialTranscriptProvider');

/**
 * Nguồn bảng điểm CHÍNH THỨC — `fetch_full_transcript_student`.
 *
 * ⚠️ API này hiện ĐANG CHẾT (xem ghi chú //died trong ehust-db.client.ts).
 * Giữ lại để khi eHUST sửa xong thì chỉ cần đặt TRANSCRIPT_PROVIDER=official.
 * Khác API _ds: bắt buộc dùng crypt_studentid (MSSV thường sẽ lỗi MAC check),
 * và response được key theo HASH chứ không phải MSSV.
 */
export class OfficialTranscriptProvider implements TranscriptProvider
{
    constructor(
        private readonly ehust: EHustDbApiClient,
    ) {}

    async getFullTranscript(studentId: string, _semester: string) {
        const profileRaw = await this.ehust.fetchProfileStudent({
            student_ids: [studentId]
        });

        const profileArray = Array.isArray(profileRaw) ? profileRaw : profileRaw?.data || [];
        const hash = profileArray[0]?.crypt_studentid;

        if (!hash) {
            logger.warn('Không lấy được crypt_studentid -> bỏ qua bảng điểm', { studentId });
            return [];
        }

        const transcriptRaw = await this.ehust.fetchFullTranscriptStudent([hash]);
        const transObj = transcriptRaw?.data || transcriptRaw;
        // API chính key theo HASH, không phải MSSV thường.
        const transcriptData = transObj?.[hash]?.full_transcript;

        if (!Array.isArray(transcriptData)) {
            logger.warn('Không trích xuất được full_transcript', { studentId });
            return [];
        }

        return transcriptData;
    }
}