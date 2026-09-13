import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsArray, ArrayMaxSize } from 'class-validator';
import { MAX_IMAGES_PER_TURN } from '@/agent/multimodal';

export class ChatRequestDto {
    @IsString()
    @IsNotEmpty()
    thread_id: string;

    @IsOptional()
    @IsString()
    student_id?: string;

    @IsString()
    @IsNotEmpty()
    message: string;

    /**
     * Ảnh sinh viên đính kèm cho lượt hỏi này. Mỗi phần tử là data-URI
     * (`data:image/jpeg;base64,...`). KHÔNG nhận URL http(s) — xem ghi chú chống
     * SSRF trong src/agent/multimodal.ts. Frontend đã nén bằng canvas trước khi gửi.
     * Ảnh chỉ dùng cho lượt hiện tại, không lưu xuống DB.
     */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(MAX_IMAGES_PER_TURN)
    @IsString({ each: true })
    images?: string[];

    @IsOptional()
    options?: {
        trace?: boolean;
        locale?: 'vi' | 'en';
    };
}
