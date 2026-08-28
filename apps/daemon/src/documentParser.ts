/**
 * Document parser for PDF and Office files.
 * All parsing happens in the daemon process.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function parseDocument(
	filePath: string,
): Promise<{ text: string; pages?: number; error?: string; success: boolean }> {
	const ext = path.extname(filePath).toLowerCase();

	switch (ext) {
		case ".pdf":
			return parsePdf(filePath);
		case ".docx":
			return parseDocx(filePath);
		case ".txt":
		case ".md":
		case ".json":
		case ".yaml":
		case ".yml":
		case ".xml":
		case ".csv":
			return parseTextFile(filePath);
		default:
			return { text: "", error: `Unsupported format: ${ext}`, success: false };
	}
}

async function parsePdf(
	filePath: string,
): Promise<{ text: string; pages?: number; success: boolean; error?: string }> {
	try {
		const { PDFParse } = await import("pdf-parse");
		const buffer = await readFile(filePath);
		const pdf = new PDFParse({ data: new Uint8Array(buffer) });
		const textResult = await pdf.getText();
		pdf.destroy();
		return {
			text: textResult.text || "",
			pages: textResult.total,
			success: true,
		};
	} catch (err: any) {
		return { text: "", pages: 0, success: false, error: err.message };
	}
}

async function parseDocx(
	filePath: string,
): Promise<{ text: string; success: boolean; error?: string }> {
	try {
		const mammoth = await import("mammoth");
		const buffer = await readFile(filePath);
		const result = await mammoth.extractRawText({ buffer });
		return { text: result.value, success: true };
	} catch (err: any) {
		return { text: "", success: false, error: err.message };
	}
}

async function parseTextFile(
	filePath: string,
): Promise<{ text: string; success: boolean; error?: string }> {
	try {
		const content = await readFile(filePath, "utf-8");
		return { text: content, success: true };
	} catch (err: any) {
		return { text: "", success: false, error: err.message };
	}
}
