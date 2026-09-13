import { EHustDbApiClient } from "@/agent/tools/clients/ehust-db.client";
import { HustApiClient } from "@/agent/tools/clients/hust-api.client";
import { TranscriptProvider } from "../transcript.provider";
import { createLogger } from "@/common/logger/logger";

const logger = createLogger("FallbackTranscriptProvider");

/**
 * Nguồn bảng điểm DỰ PHÒNG — dùng `fetch_full_transcript_student_ds`.
 *
 * Vì sao cần: API chính `fetch_full_transcript_student` đã CHẾT.
 * API _ds nhận MSSV THƯỜNG (không cần crypt_studentid) và trả về
 *   { "<mssv>": { student_id, full_transcript: [...] } }   (không có wrapper `data`)
 * nhưng THIẾU trường so với API cũ: không có GradeClass/GradeExam/MarkChar,
 * và `finalMarkLetter` rỗng ở khá nhiều bản ghi -> phải tự suy ở normalizeTranscript().
 */
export class FallbackTranscriptProvider implements TranscriptProvider {
  constructor(
    private readonly ehust: EHustDbApiClient,
    private readonly hust: HustApiClient,
  ) {}

  async getFullTranscript(studentId: string, semester: string) {
    // getClasses chỉ dùng để lọc lớp đã huỷ -> nếu nó lỗi thì KHÔNG được
    // làm chết cả việc lấy bảng điểm.
    const [transcriptRes, classesRes] = await Promise.allSettled([
      this.ehust.fetchFullTranscriptStudentDS([studentId]),
      this.hust.getClasses(studentId, semester),
    ]);

    if (transcriptRes.status === "rejected") {
      logger.error("Không lấy được bảng điểm từ API _ds", {
        studentId,
        error: String(transcriptRes.reason),
      });
      return [];
    }

    const result = transcriptRes.value as any;
    let transcript: any[] = result?.[studentId]?.full_transcript ?? [];

    if (!Array.isArray(transcript) || transcript.length === 0) {
      logger.warn("API _ds trả về full_transcript rỗng", { studentId });
      return [];
    }

    const classes =
      classesRes.status === "fulfilled" && Array.isArray(classesRes.value)
        ? (classesRes.value as any[])
        : [];

    if (classesRes.status === "rejected") {
      logger.warn(
        "getClasses lỗi -> bỏ qua bước lọc lớp đã huỷ, vẫn trả bảng điểm",
        { studentId, error: String(classesRes.reason) },
      );
    }

    transcript = this.removeObsoleteClasses(transcript, classes);

    transcript = this.dedupeComponentRows(transcript);

    this.normalizeTranscript(transcript);

    return transcript;
  }

  /**
   * API _ds trả về NHIỀU DÒNG cho cùng một môn trong cùng một kỳ, tách theo loại
   * lớp (LT+BT / BT / TN / TH / DA), nhưng `finalMarkLetter` chỉ nằm ở ĐÚNG MỘT dòng.
   *
   * Nếu không gom lại, normalizeTranscript() sẽ tự suy điểm cho các dòng thành phần
   * còn thiếu điểm chữ -> sinh viên thấy 2 điểm cho 1 môn, trong đó 1 điểm là bịa.
   * Ví dụ thật (MSSV 20225976):
   *    IT3080E  20232  LT+BT  exam=8.5 proc=8.0  letter=''    -> code cũ suy ra C+
   *    IT3080E  20232  TN     exam=8.5 proc=5.0  letter='B+'  -> điểm THẬT
   *
   * Quy tắc: gom theo CourseID + TermID (KHÔNG gom theo môn, để học lại ở kỳ khác
   * vẫn là 2 lần học riêng biệt). Trong mỗi nhóm ưu tiên:
   *   1. dòng đã có `finalMarkLetter` thật;
   *   2. nếu cả nhóm chưa có điểm chữ -> lấy dòng KHÔNG phải TN (giữ QT/CK thật)
   *      để normalizeTranscript tự suy.
   * Chỉ giữ QT / CK / điểm chữ; các dòng TN dư không cần quan tâm.
   */
  private dedupeComponentRows(transcript: any[]): any[] {
    const groups = new Map<string, any[]>();
    for (const row of transcript) {
      const key = `${row.CourseID}::${row.TermID}`;
      const g = groups.get(key);
      if (g) g.push(row);
      else groups.set(key, [row]);
    }

    const hasLetter = (r: any) => r.finalMarkLetter !== '' && r.finalMarkLetter != null;
    const hasMark = (r: any) =>
      (r.examMark !== '' && r.examMark != null) ||
      (r.processMark !== '' && r.processMark != null);

    const out: any[] = [];
    let dropped = 0;

    for (const rows of groups.values()) {
      if (rows.length === 1) {
        out.push(rows[0]);
        continue;
      }

      // 1. Đã có điểm chữ thật -> lấy dòng đó, tuyệt đối không tự suy thêm.
      const withLetter = rows.filter(hasLetter);
      if (withLetter.length > 0) {
        out.push(withLetter[0]);
        dropped += rows.length - 1;
        continue;
      }

      // 2. Chưa có điểm chữ -> ưu tiên dòng không phải TN và có điểm để suy ra.
      const preferred =
        rows.find((r) => r.ClassType !== 'TN' && hasMark(r)) ??
        rows.find((r) => hasMark(r)) ??
        rows[0];
      out.push(preferred);
      dropped += rows.length - 1;
    }

    if (dropped > 0) {
      logger.info(`Đã gộp ${dropped} dòng lớp thành phần trùng môn/kỳ`, {
        truoc: transcript.length,
        sau: out.length,
      });
    }

    return out;
  }

  private removeObsoleteClasses(transcript: any[], classes: any[]) {
    const currentCourseIds = new Set(classes.map((c) => c.courseId));

    const removedCourses = transcript.filter((course) => {
      const hasNoMark =
        (course.examMark === "" || course.examMark == null) &&
        (course.processMark === "" || course.processMark == null) &&
        (course.finalMarkLetter === "" || course.finalMarkLetter == null);

      return hasNoMark && !currentCourseIds.has(course.CourseID);
    });

    if (removedCourses.length > 0) {
      logger.info(`Đã loại ${removedCourses.length} lớp không còn hiệu lực`, {
        courses: removedCourses.map(
          (c) => `${c.CourseID}/${c.TermID}/${c.ClassType}`,
        ),
      });
    }

    return transcript.filter((course) => {
      const hasNoMark =
        (course.examMark === "" || course.examMark == null) &&
        (course.processMark === "" || course.processMark == null) &&
        (course.finalMarkLetter === "" || course.finalMarkLetter == null);

      return !(hasNoMark && !currentCourseIds.has(course.CourseID));
    });
  }
  /**
   * Chuẩn hóa transcript về format giống API cũ
   */
 private normalizeTranscript(transcript: any[]) {
  for (const course of transcript) {
    
    if (
      !course.finalMarkLetter &&
      course.examWeight != null
    ) {
      const examWeight = Number(course.examWeight);
      const processWeight = 1 - examWeight;

      const hasExam =
        course.examMark !== "" && course.examMark != null;
      const hasProcess =
        course.processMark !== "" && course.processMark != null;

      if (
        (examWeight === 0 || hasExam) &&
        (processWeight === 0 || hasProcess)
      ) {
        const examMark = hasExam ? Number(course.examMark) : 0;
        const processMark = hasProcess ? Number(course.processMark) : 0;

        const rawScore =
          examMark * examWeight +
          processMark * processWeight;

        // Làm tròn 1 chữ số TRƯỚC khi quy ra điểm chữ — đúng cách HUST tính.
        // Nếu quy trực tiếp từ số thô sẽ lệch ở biên: 7.5*0.7 + 9.0*0.3 = 7.95
        // -> quy thô ra "B", nhưng điểm thật của trường là "B+" (7.95 -> 8.0).
        const finalScore = Number(rawScore.toFixed(1));

        course.finalScore = finalScore;

        const failed =
          (examWeight > 0 && examMark < 3) ||
          (processWeight > 0 && processMark < 3) ||
          finalScore < 4;

        course.finalMarkLetter = failed
          ? "F"
          : this.calculateFinalMarkLetter(finalScore);
      }
    }

    // Mapping sang format API cũ
    course.GradeClass = course.processMark;
    course.GradeExam = course.examMark;
    course.MarkChar = course.finalMarkLetter;
  }
}

  private calculateFinalMarkLetter(score: number): string {
    if (score >= 9.5) return "A+";
    if (score >= 8.5) return "A";
    if (score >= 8.0) return "B+";
    if (score >= 7.0) return "B";
    if (score >= 6.5) return "C+";
    if (score >= 5.5) return "C";
    if (score >= 5.0) return "D+";
    if (score >= 4.0) return "D";
    return "F";
  }
}
