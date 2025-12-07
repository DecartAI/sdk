export async function getDefaultImageFile(fileUrl: string): Promise<File> {
	const response = await fetch(fileUrl);
	const blob = await response.blob();
	return new File([blob], "example.webp", { type: "image/webp" });
}
