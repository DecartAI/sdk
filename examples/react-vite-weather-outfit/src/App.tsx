import { useEffect, useState } from "react";
import personExample from "./assets/person-example.webp";
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({
	apiKey: import.meta.env.VITE_DECART_API_KEY,
});

function App() {
	const [imageFile, setImageFile] = useState<File | null>(null);
	const [imageUrl, setImageUrl] = useState(personExample);
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
		if (!imageFile) {
			setImageUrl(personExample);
			return;
		}

		const nextUrl = URL.createObjectURL(imageFile);
		setImageUrl(nextUrl);

		return () => URL.revokeObjectURL(nextUrl);
	}, [imageFile]);

	const generateOutfit = async () => {
		try {
			const result = await client.process({
				model: models.image("lucy-pro-i2i"),
				data: imageUrl,
				prompt: "A person wearing a warm outfit for the weather condition",
			});
			console.log(result);
		} catch (error) {
			console.error(error);
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
								onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
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

					<button type="button" onClick={generateOutfit}>
						Generate outfit
					</button>
				</div>
				<strong>Result:</strong>
			</div>
		</div>
	);
}

export default App;
