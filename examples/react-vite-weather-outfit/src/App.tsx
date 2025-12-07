import { createDecartClient, models } from "@decartai/sdk";
import { type ChangeEvent, useEffect, useState } from "react";
import personExampleUrl from "./assets/person-example.webp";
import { getDefaultImageFile } from "./helpers";
import { useObjectURL } from "./useObjectURL";
import { WEATHER_OPTIONS, WeatherConditions } from "./WeatherConditions";

const client = createDecartClient({
	apiKey: import.meta.env.VITE_DECART_API_KEY,
});

function App() {
	const [imageFile, setImageFile] = useState<File | undefined>();
	const [resultFile, setResultFile] = useState<File | undefined>();

	const imageUrl = useObjectURL(imageFile);
	const resultUrl = useObjectURL(resultFile);

	const [isLoading, setIsLoading] = useState(false);
	const [condition, setCondition] = useState(WEATHER_OPTIONS[0]);

	useEffect(() => {
		getDefaultImageFile(personExampleUrl).then(setImageFile);
	}, []);

	const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		setResultFile(undefined);
		setImageFile(file ?? undefined);
	};

	const generateOutfit = async () => {
		if (!imageFile) return;
		setIsLoading(true);
		setResultFile(undefined);
		try {
			const resultBlob = await client.process({
				model: models.image("lucy-pro-i2i"),
				data: imageFile,
				prompt: `A person wearing an outfit for ${condition.toLowerCase()} conditions`,
			});

			setResultFile(
				new File([resultBlob], "result.webp", { type: "image/webp" }),
			);
		} catch (error) {
			console.error(error);
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<div style={{ paddingInline: "2rem", fontFamily: "system-ui" }}>
			<h1>Decart Weather Outfit Demo</h1>

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "1.25fr 1fr",
					gap: "5rem",
				}}
			>
				<div>
					<WeatherConditions
						value={condition}
						onChange={setCondition}
						options={WEATHER_OPTIONS}
					/>

					<div style={{ marginBlock: "1rem" }}>
						<label>
							Image:
							<input
								type="file"
								accept="image/*"
								onChange={handleFileChange}
								style={{ width: "300px", marginLeft: "0.5rem" }}
							/>
						</label>
					</div>

					<img
						src={imageUrl}
						alt="Selected outfit"
						style={{
							display: "block",
							maxWidth: "300px",
							maxHeight: "420px",
							borderRadius: "0.5rem",
							marginBottom: "1rem",
						}}
					/>

					<button
						type="button"
						onClick={generateOutfit}
						disabled={isLoading || !imageFile}
					>
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
						<p style={{ marginTop: "0.5rem" }}>
							{isLoading ? "Generating..." : "No result yet."}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

export default App;
