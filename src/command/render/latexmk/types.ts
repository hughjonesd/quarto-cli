import { PdfEngine } from "../../../config/pdf.ts";

export const kLatexHeaderMessageOptions = { bold: true };
export const kLatexBodyMessageOptions = { indent: 2 };

// latexmk options
export interface LatexmkOptions {
  input: string;
  engine: PdfEngine;
  autoInstall?: boolean;
  autoMk?: boolean;
  minRuns?: number;
  maxRuns?: number;
  outputDir?: string;
  clean?: boolean;
  quiet?: boolean;
}