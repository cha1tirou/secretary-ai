declare module "pdf-parse" {
  interface TextResult {
    pages: { text: string; num: number }[];
    text: string;
    total: number;
  }
  export class PDFParse {
    constructor(options: { data: Buffer | Uint8Array });
    getText(): Promise<TextResult>;
  }
}
