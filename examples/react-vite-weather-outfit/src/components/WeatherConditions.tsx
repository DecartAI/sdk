type WeatherConditionsProps = {
	value: string;
	onChange: (condition: string) => void;
	options: string[];
};

export const WEATHER_OPTIONS = [
	"Sunny",
	"Partly cloudy",
	"Light rain",
	"Thunderstorm",
	"Snow",
];

export function WeatherConditions(props: WeatherConditionsProps) {
	const { value, onChange, options } = props;
	return (
		<>
			<strong>Weather condition:</strong>
			<div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
				{options.map((option) => (
					<label key={option} style={{ display: "block" }}>
						<input
							type="radio"
							name="weather"
							value={option}
							checked={value === option}
							onChange={() => onChange(option)}
						/>
						<span style={{ marginLeft: "0.5rem" }}>{option}</span>
					</label>
				))}
			</div>
		</>
	);
}
