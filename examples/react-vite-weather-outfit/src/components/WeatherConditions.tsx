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
			<div className="weather-options">
				{options.map((option) => (
					<label key={option} className="weather-option-label">
						<input
							type="radio"
							name="weather"
							value={option}
							checked={value === option}
							onChange={() => onChange(option)}
						/>
						<span className="weather-option-text">{option}</span>
					</label>
				))}
			</div>
		</>
	);
}
