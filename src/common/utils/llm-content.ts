/**
 * llm-content.ts — trích text an toàn từ `content` của message LangChain.
 *
 * VÌ SAO CẦN:
 * Tuỳ model/provider mà `AIMessage.content` có thể là:
 *   - string:  "Xin chào"                                  (Gemini 2.5 qua Google SDK)
 *   - mảng content-block: [{ type: 'text', text: 'Xin chào' }]
 *                                                          (Gemini 3.x qua LiteLLM/OpenAI-compat,
 *                                                           đặc biệt khi bật thinking)
 * Code cũ dùng `String(result.content)` -> với mảng block sẽ ra "[object Object]".
 * Hậu quả đã gặp thật:
 *   - /v1/chat/respond trả về đúng chữ "[object Object]".
 *   - node.generate-title parse JSON thất bại -> im lặng rơi về fallback
 *     "cắt 30 ký tự câu hỏi", nên tiêu đề hội thoại mất chất lượng mà không ai thấy lỗi.
 *
 * Luồng stream không lộ bug vì mỗi chunk là string, nhưng nhánh `Array.isArray`
 * ở facade lại `.join('')` trên mảng object -> cũng sẽ ra "[object Object]" nếu
 * provider đổi hành vi. Dùng hàm này ở mọi nơi cho chắc.
 */

/** Lấy text từ 1 content-block đơn lẻ. */
function blockToText(block: unknown): string {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return '';

    const b = block as Record<string, unknown>;

    // Chỉ nhận block văn bản. BỎ QUA block suy luận (thinking/reasoning) để
    // không rò rỉ chuỗi suy nghĩ của model vào câu trả lời gửi sinh viên.
    if (b.type === 'thinking' || b.type === 'reasoning' || b.type === 'redacted_thinking') {
        return '';
    }

    if (typeof b.text === 'string') return b.text;
    if (typeof b.content === 'string') return b.content;

    return '';
}

/**
 * Trích toàn bộ text từ `content` của message (string | mảng block | khác).
 * Luôn trả về string, không bao giờ ra "[object Object]".
 */
export function extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(blockToText).join('');
    if (content == null) return '';
    return blockToText(content);
}

/**
 * Trích text từ một message/chunk của LangChain.
 * Ưu tiên getter `.text` do LangChain cung cấp (đã xử lý sẵn content-block),
 * nếu không có thì tự flatten `.content`.
 */
export function messageText(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const m = message as Record<string, unknown>;
    if (typeof m.text === 'string' && m.text.length > 0) return m.text;
    return extractText(m.content);
}
