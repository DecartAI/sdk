import { useEffect, useState } from "react";
import personExampleUrl from "./assets/person-example.webp";
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({
	apiKey: import.meta.env.VITE_DECART_API_KEY,
});

function App() {
	const [imageFile, setImageFile] = useState<File | undefined>(undefined);
	const [imageUrl, setImageUrl] = useState<string | undefined>(
		personExampleUrl,
	);
	const [resultUrl, setResultUrl] = useState<string | undefined>(undefined);
	const [isLoading, setIsLoading] = useState(false);

	const weatherOptions = [
		"Sunny",
		"Partly cloudy",
		"Overcast",
		"Light rain",
		"Thunderstorm",
		"Snow",
		"Windy",
	];
	const [condition, setCondition] = useState(weatherOptions[0]);

	useEffect(() => {
		let cancelled = false;

		(async () => {
			try {
				const response = await fetch(personExampleUrl);
				const blob = await response.blob();
				if (cancelled) return;

				setImageFile(
					new File([blob], "person-example.webp", {
						type: blob.type || "image/webp",
					}),
				);
			} catch (error) {
				console.error("Failed to load sample image", error);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!imageFile) return;
		const nextUrl = URL.createObjectURL(imageFile);
		setImageUrl(nextUrl);

		return () => URL.revokeObjectURL(nextUrl);
	}, [imageFile]);

	const generateOutfit = async () => {
		if (!imageFile) return;
		setIsLoading(true);
		try {
			const result = await client.process({
				model: models.image("lucy-pro-i2i"),
				data: imageFile,
				prompt: "A person wearing a warm outfit for the weather condition",
			});

			const resultUrl = URL.createObjectURL(result);
			setResultUrl(resultUrl);
		} catch (error) {
			console.error(error);
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<div style={{ padding: "2rem", fontFamily: "system-ui" }}>
			<h1>Decart Weather Outfit Demo</h1>

			<div
				style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "5rem" }}
			>
				<div>
					<div style={{ marginBottom: "1rem" }}>
						<strong>Weather condition:</strong>
						<div
							style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}
						>
							{weatherOptions.map((option) => (
								<label
									key={option}
									style={{ display: "block", marginBottom: "0.25rem" }}
								>
									<input
										type="radio"
										name="weather"
										value={option}
										checked={condition === option}
										onChange={() => setCondition(option)}
									/>
									<span style={{ marginLeft: "0.5rem" }}>{option}</span>
								</label>
							))}
						</div>
					</div>

					<div style={{ marginBottom: "1rem" }}>
						<label>
							Image:
							<input
								type="file"
								accept="image/*"
								onChange={(e) => setImageFile(e.target.files?.[0] ?? undefined)}
								style={{
									marginLeft: "0.5rem",
									width: "300px",
									padding: "0.5rem",
								}}
							/>
						</label>
					</div>

					<img
						src={imageUrl}
						alt="Selected outfit"
						style={{
							display: "block",
							maxWidth: "300px",
							borderRadius: "0.5rem",
							marginBottom: "1rem",
						}}
					/>

					<button type="button" onClick={generateOutfit} disabled={isLoading}>
						{isLoading ? "Generating..." : "Generate outfit"}
					</button>
				</div>
				<div>
					<strong>Result:</strong>
					{resultUrl ? (
						<img
							src={resultUrl}
							alt=""
							style={{
								display: "block",
								maxWidth: "300px",
								borderRadius: "0.5rem",
								marginTop: "1rem",
							}}
						/>
					) : (
						<p style={{ marginTop: "0.5rem" }}>No result yet.</p>
					)}
				</div>
			</div>
		</div>
	);
}

export default App;
