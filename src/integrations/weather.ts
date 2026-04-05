const API_KEY = process.env["WEATHER_API_KEY"] ?? "";
const CITY = process.env["WEATHER_CITY"] ?? "Tokyo";

type ForecastItem = {
  dt: number;
  main: { temp: number; temp_min: number; temp_max: number };
  weather: { description: string; icon: string }[];
  pop: number; // probability of precipitation
};

function weatherIcon(iconCode: string): string {
  if (iconCode.startsWith("01")) return "\u2600\uFE0F"; // ☀️
  if (iconCode.startsWith("02")) return "\u26C5";       // ⛅
  if (iconCode.startsWith("03") || iconCode.startsWith("04")) return "\u2601\uFE0F"; // ☁️
  if (iconCode.startsWith("09") || iconCode.startsWith("10")) return "\u2602\uFE0F"; // ☂️
  if (iconCode.startsWith("11")) return "\u26C8\uFE0F"; // ⛈️
  if (iconCode.startsWith("13")) return "\u2744\uFE0F"; // ❄️
  return "\uD83C\uDF24\uFE0F"; // 🌤️
}

async function fetchForecast(): Promise<ForecastItem[] | null> {
  if (!API_KEY) return null;
  try {
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/forecast?q=${CITY}&appid=${API_KEY}&units=metric&lang=ja`
    );
    if (!res.ok) return null;
    const data = await res.json() as { list: ForecastItem[] };
    return data.list;
  } catch {
    return null;
  }
}

function buildSummary(items: ForecastItem[], label: string): string {
  if (items.length === 0) return "";

  const maxTemp = Math.round(Math.max(...items.map((i) => i.main.temp_max)));
  const minTemp = Math.round(Math.min(...items.map((i) => i.main.temp_min)));
  const maxPop = Math.round(Math.max(...items.map((i) => i.pop)) * 100);

  // Find the most common weather in the day
  const icon = items[Math.floor(items.length / 2)]?.weather[0]?.icon ?? "01d";
  const desc = items[Math.floor(items.length / 2)]?.weather[0]?.description ?? "";

  let text = `${weatherIcon(icon)} ${label}${desc}\u3001\u6700\u9AD8${maxTemp}\u2103\u30FB\u6700\u4F4E${minTemp}\u2103`;
  if (maxPop >= 50) {
    text += `\u3002\u2602\uFE0F \u964D\u6C34\u78BA\u7387${maxPop}%\u3001\u50B5\u3092\u304A\u5FD8\u308C\u306A\u304F\u3002`;
  } else if (maxPop >= 30) {
    text += `\u3002\u964D\u6C34\u78BA\u7387${maxPop}%\u3001\u5FF5\u306E\u305F\u3081\u50B5\u304C\u3042\u308B\u3068\u5B89\u5FC3\u3002`;
  } else {
    text += `\u3002`;
  }
  return text;
}

export async function getWeatherSummary(): Promise<string> {
  try {
    const items = await fetchForecast();
    if (!items) return "";

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const todayEnd = todayStart + 86400;
    const todayItems = items.filter((i) => i.dt >= todayStart && i.dt < todayEnd);

    return buildSummary(todayItems, "");
  } catch {
    return "";
  }
}

export async function getTomorrowWeatherSummary(): Promise<string> {
  try {
    const items = await fetchForecast();
    if (!items) return "";

    const now = new Date();
    const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000;
    const tomorrowEnd = tomorrowStart + 86400;
    const tomorrowItems = items.filter((i) => i.dt >= tomorrowStart && i.dt < tomorrowEnd);

    return buildSummary(tomorrowItems, "\u660E\u65E5\u306F");
  } catch {
    return "";
  }
}
