export interface TranscriptProvider {
    getFullTranscript(studentId: string, semester: string): Promise<any>;
}