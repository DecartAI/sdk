import { createDecartClient, models } from "@decartai/sdk";
import { type ChangeEvent, useEffect, useState } from "react";
import personExampleUrl from "./assets/person-example.webp";
import {
	WEATHER_OPTIONS,
	WeatherConditions,
} from "./components/WeatherConditions";
import { getDefaultImageFile } from "./helpers";
import { useObjectURL } from "./hooks/useObjectURL";
import "./App.css";

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
		<div className="app">
			<h1>Decart Weather Outfit Demo</h1>

			<div className="layout">
				<div>
					<WeatherConditions
						value={condition}
						onChange={setCondition}
						options={WEATHER_OPTIONS}
					/>

					<div className="file-input">
						<label>
							Image:
							<input
								type="file"
								accept="image/*"
								onChange={handleFileChange}
								className="file-input-control"
							/>
						</label>
					</div>

					<img src={imageUrl} alt="Selected outfit" className="preview-image" />

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
						<img src={resultUrl} alt="" className="result-image" />
					) : (
						<p className="result-placeholder">
							{isLoading ? "Generating..." : "No result yet."}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

export default App;
