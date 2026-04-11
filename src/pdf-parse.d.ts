declare module "pdf-parse" {
  interface PDFData {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }
  export default function pdfParse(buffer: Buffer): Promise<PDFData>;
}
