declare module "screenshot-desktop" {
	interface ScreenshotOptions {
		format?: "png" | "jpg" | "jpeg";
		screen?: number;
	}
	function screenshot(options?: ScreenshotOptions): Promise<Buffer>;
	export default screenshot;
}
