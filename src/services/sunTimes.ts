/**
 * Sun times from the NOAA solar-position approximation (accuracy about 1-2 minutes at German latitudes).
 * Pure calculation: no network, no dependency. Valid for latitudes below about 65 degrees.
 */
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function solar(year: number, month: number, day: number) {
  const dayOfYear = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const equationOfTimeMin = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const declination = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  return { equationOfTimeMin, declination };
}

/** UTC instant when the sun center crosses `elevationDeg` on the given calendar date, or null if it never does. */
export function sunCrossing(latitude: number, longitude: number, date: string, elevationDeg: number, rising: boolean): Date | null {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const { equationOfTimeMin, declination } = solar(y, m, d);
  const cosHa = (Math.sin(rad(elevationDeg)) - Math.sin(rad(latitude)) * Math.sin(declination)) / (Math.cos(rad(latitude)) * Math.cos(declination));
  if (cosHa < -1 || cosHa > 1) return null;
  const hourAngle = deg(Math.acos(cosHa));
  const minutesUtc = 720 - 4 * (longitude + (rising ? hourAngle : -hourAngle)) - equationOfTimeMin;
  return new Date(Date.UTC(y, m - 1, d) + minutesUtc * 60000);
}

const clock = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const local = (d: Date | null) => (d ? clock.format(d) : null);

export interface SunTimes {
  timezone: "Europe/Berlin";
  civil_dawn: string | null; sunrise: string | null; golden_hour_morning_ends: string | null;
  golden_hour_evening_starts: string | null; sunset: string | null; civil_dusk: string | null;
  daylight_minutes: number | null;
}

/** Local (Europe/Berlin) clock times. Golden hour = sun between the horizon and 6 degrees elevation. */
export function sunTimes(latitude: number, longitude: number, date: string): SunTimes {
  const at = (elevation: number, rising: boolean) => sunCrossing(latitude, longitude, date, elevation, rising);
  const rise = at(-0.833, true), set = at(-0.833, false);
  return {
    timezone: "Europe/Berlin",
    civil_dawn: local(at(-6, true)), sunrise: local(rise), golden_hour_morning_ends: local(at(6, true)),
    golden_hour_evening_starts: local(at(6, false)), sunset: local(set), civil_dusk: local(at(-6, false)),
    daylight_minutes: rise && set ? Math.round((set.getTime() - rise.getTime()) / 60000) : null,
  };
}
