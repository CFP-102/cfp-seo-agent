/**
 * Small, hand-written trade vocabulary for the video project planner: turns "Metallbau" into concrete job titles,
 * work areas, typical activities and safety notes, so idea titles and checklists fit the customer's trade.
 * No AI model; unknown trades fall back to neutral wording. Matching is on plain keywords.
 */
export interface Trade {
  id: string;
  label: string;
  /** Lower-case, umlaut-folded keywords that select this trade. */
  keywords: string[];
  job: string;
  apprenticeship: string;
  /** [main workplace, spot of the typical activity, quiet room for talks]; repeats are fine. */
  areas: string[];
  activities: string[];
  product: string;
  tool: string;
  outdoorWork: string | null;
  safety: string[];
}

export const TRADES: Trade[] = [
  {
    id: "metallbau", label: "Metallbau", keywords: ["metallbau", "metall", "schlosser", "stahlbau", "schweiss", "metal", "welding", "steel fabrication"],
    job: "Metallbauer:in", apprenticeship: "Ausbildung zum Metallbauer (m/w/d)", areas: ["Werkstatt", "Schweißplatz", "Büro"],
    activities: ["Schweißen", "Biegen und Kanten", "Montage beim Kunden"], product: "Geländer", tool: "Schweißgerät",
    outdoorWork: "Montage beim Kunden",
    safety: [
      "Schweißen nur mit Schutzfilter vor der Kamera und Abstand zum Funkenflug filmen; nie ungeschützt in den Lichtbogen zoomen.",
      "Persönliche Schutzausrüstung im Bild korrekt tragen: Recruiting-Videos werden von Fachleuten genau angeschaut.",
      "Interviews nicht neben laufenden Maschinen aufnehmen; Lärmquellen für die Tonaufnahme kurz abschalten lassen.",
    ],
  },
  {
    id: "zimmerei", label: "Zimmerei", keywords: ["zimmerei", "zimmerer", "dach", "dachdecker", "holzbau", "roofing", "roofer", "timber frame", "timber construction"],
    job: "Zimmerer/Zimmerin", apprenticeship: "Ausbildung zum Zimmerer (m/w/d)", areas: ["Abbundhalle", "Abbundhalle", "Büro"],
    activities: ["Abbund", "Dachstuhl aufrichten", "Arbeiten in der Höhe"], product: "Dachstuhl", tool: "Kettensäge",
    outdoorWork: "Dachstuhl aufrichten",
    safety: ["Höhenaufnahmen nur mit Absturzsicherung; das Filmteam bleibt am Boden oder gesichert."],
  },
  {
    id: "schreinerei", label: "Schreinerei", keywords: ["schreiner", "tischler", "holz", "moebel", "mobel", "joinery", "joiner", "carpent", "cabinet", "furniture", "woodwork"],
    job: "Schreiner:in", apprenticeship: "Ausbildung zum Schreiner (m/w/d)", areas: ["Werkstatt", "Maschinenraum", "Büro"],
    activities: ["Zuschnitt", "Oberflächenbehandlung", "Montage beim Kunden"], product: "Möbelstück", tool: "Formatkreissäge",
    outdoorWork: "Montage beim Kunden",
    safety: ["Absaugung und Gehörschutz im Bild beachten.", "Für Interviews die Maschinen abschalten lassen."],
  },
  {
    id: "elektro", label: "Elektrotechnik", keywords: ["elektro", "elektriker", "elektronik", "electric"],
    job: "Elektroniker:in", apprenticeship: "Ausbildung zum Elektroniker (m/w/d)", areas: ["Werkstatt", "Schaltschrankbau", "Büro"],
    activities: ["Verdrahtung im Schaltschrank", "Installation auf der Baustelle", "Fehlersuche mit Messgerät"], product: "Schaltschrank", tool: "Messgerät",
    outdoorWork: "Installation auf der Baustelle",
    safety: ["Nur an freigeschalteten Anlagen filmen; keine Arbeiten unter Spannung inszenieren."],
  },
  {
    id: "shk", label: "Sanitär, Heizung, Klima", keywords: ["shk", "sanitaer", "sanitar", "heizung", "klima", "installateur", "plumb", "heating", "hvac"],
    job: "Anlagenmechaniker:in SHK", apprenticeship: "Ausbildung zum Anlagenmechaniker SHK (m/w/d)", areas: ["Werkstatt", "Werkstatt", "Büro"],
    activities: ["Rohre verpressen", "Heizung einbauen", "Wartung beim Kunden"], product: "Heizungsanlage", tool: "Pressmaschine",
    outdoorWork: "Wartung beim Kunden",
    safety: ["Beim Kunden vorher die Drehgenehmigung einholen und private Gegenstände aus dem Bild nehmen."],
  },
  {
    id: "kfz", label: "Kfz-Werkstatt", keywords: ["kfz", "autohaus", "autowerkstatt", "mechatroniker", "karosserie", "car repair", "auto repair", "garage", "mechanic", "body shop", "car dealer"],
    job: "Kfz-Mechatroniker:in", apprenticeship: "Ausbildung zum Kfz-Mechatroniker (m/w/d)", areas: ["Werkstatt", "Hebebühne", "Kundenannahme"],
    activities: ["Diagnose am Fahrzeug", "Reifenwechsel", "Arbeiten an der Hebebühne"], product: "Fahrzeug", tool: "Diagnosegerät",
    outdoorWork: null,
    safety: ["Kennzeichen von Kundenfahrzeugen abdecken oder nicht zeigen."],
  },
  {
    id: "bau", label: "Bau", keywords: ["bauunternehmen", "baufirma", "maurer", "hochbau", "tiefbau", "beton", "construction", "builder", "bricklay", "masonry", "concrete"],
    job: "Maurer:in", apprenticeship: "Ausbildung zum Maurer (m/w/d)", areas: ["Bauhof", "Baustelle", "Büro"],
    activities: ["Mauern", "Schalung bauen", "Arbeiten mit dem Kran"], product: "Rohbau", tool: "Kelle",
    outdoorWork: "Arbeiten auf der Baustelle",
    safety: ["Baustelle nur mit Helm und Sicherheitsschuhen betreten, auch das Filmteam.", "Bauherr bzw. Bauleitung um Drehgenehmigung bitten."],
  },
  {
    id: "baeckerei", label: "Bäckerei", keywords: ["baecker", "backer", "baeckerei", "konditor", "bakery", "baker", "pastry"],
    job: "Bäcker:in", apprenticeship: "Ausbildung zum Bäcker (m/w/d)", areas: ["Backstube", "Backstube", "Verkauf"],
    activities: ["Teig kneten", "Brot aus dem Ofen holen", "Verkauf am Morgen"], product: "Brot", tool: "Ofen",
    outdoorWork: null,
    safety: ["Hygienevorschriften auch für das Filmteam (Haube, saubere Kleidung)."],
  },
  {
    id: "pflege", label: "Pflege", keywords: ["pflegedienst", "pflegeheim", "altenpflege", "krankenpflege", "pflegefach", "altenheim", "krankenhaus", "klinik", "senioren", "nursing", "care home", "care service", "hospital", "elderly care"],
    job: "Pflegefachkraft", apprenticeship: "Ausbildung zur Pflegefachkraft (m/w/d)", areas: ["Station", "Aufenthaltsraum", "Büro"],
    activities: ["Übergabe im Team", "Gemeinsame Aktivität", "Dokumentation"], product: "Pflegealltag", tool: "Pflegedokumentation",
    outdoorWork: null,
    safety: ["Keine Bewohner oder Patienten ohne schriftliche Einwilligung filmen; im Zweifel nur das Team zeigen."],
  },
  {
    id: "gastro", label: "Gastronomie und Hotel", keywords: ["gastro", "hotel", "restaurant", "koch", "kueche", "kuche", "catering", "chef", "kitchen", "hospitality"],
    job: "Koch/Köchin", apprenticeship: "Ausbildung zum Koch (m/w/d)", areas: ["Küche", "Küche", "Restaurant"],
    activities: ["Anrichten", "Service am Gast", "Vorbereitung vor dem Service"], product: "Gericht", tool: "Messer",
    outdoorWork: null,
    safety: ["Gäste nur mit Einwilligung zeigen; am besten vor der Öffnung drehen."],
  },
  {
    id: "logistik", label: "Logistik", keywords: ["logistik", "lager", "spedition", "transport", "versand", "logistics", "warehouse", "shipping", "freight"],
    job: "Fachkraft für Lagerlogistik", apprenticeship: "Ausbildung zur Fachkraft für Lagerlogistik (m/w/d)", areas: ["Lager", "Verladung", "Büro"],
    activities: ["Kommissionieren", "Staplerfahren", "Verladen"], product: "Lieferung", tool: "Gabelstapler",
    outdoorWork: "Verladen",
    safety: ["Staplerverkehr: Filmteam mit Warnweste, feste Standorte absprechen."],
  },
];

const fold = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");

type TradeText = Pick<Trade, "label" | "job" | "apprenticeship" | "areas" | "activities" | "product" | "tool" | "outdoorWork" | "safety">;
/** English texts per trade id (same structure as the German fields). */
const TRADES_EN: Record<string, TradeText> = {
  metallbau: {
    label: "Metalwork", job: "metalworker", apprenticeship: "apprenticeship as a metalworker", areas: ["Workshop", "Welding bay", "Office"],
    activities: ["Welding", "Bending and folding", "Installation on site"], product: "railing", tool: "welding machine", outdoorWork: "Installation on site",
    safety: [
      "Film welding only with a protective filter in front of the lens and distance from sparks; never zoom into the arc unprotected.",
      "Personal protective equipment must be worn correctly on camera: professionals watch recruiting videos closely.",
      "Do not record interviews next to running machines; have noise sources switched off briefly for sound.",
    ],
  },
  zimmerei: {
    label: "Carpentry and timber construction", job: "carpenter", apprenticeship: "apprenticeship as a carpenter", areas: ["Timber hall", "Timber hall", "Office"],
    activities: ["Timber cutting", "Raising a roof frame", "Working at height"], product: "roof frame", tool: "chainsaw", outdoorWork: "Raising a roof frame",
    safety: ["Shots at height only with fall protection; the film crew stays on the ground or secured."],
  },
  schreinerei: {
    label: "Joinery", job: "joiner", apprenticeship: "apprenticeship as a joiner", areas: ["Workshop", "Machine room", "Office"],
    activities: ["Cutting to size", "Surface finishing", "Installation on site"], product: "piece of furniture", tool: "panel saw", outdoorWork: "Installation on site",
    safety: ["Show dust extraction and hearing protection correctly.", "Have machines switched off for interviews."],
  },
  elektro: {
    label: "Electrical engineering", job: "electrician", apprenticeship: "apprenticeship as an electrician", areas: ["Workshop", "Control cabinet assembly", "Office"],
    activities: ["Wiring a control cabinet", "Installation on the building site", "Fault finding with a meter"], product: "control cabinet", tool: "multimeter", outdoorWork: "Installation on the building site",
    safety: ["Film only on de-energised installations; never stage live work."],
  },
  shk: {
    label: "Plumbing, heating and air conditioning", job: "plumbing and heating technician", apprenticeship: "apprenticeship in plumbing and heating", areas: ["Workshop", "Workshop", "Office"],
    activities: ["Pressing pipes", "Installing a heating system", "Maintenance at the customer's"], product: "heating system", tool: "press tool", outdoorWork: "Maintenance at the customer's",
    safety: ["At the customer's, get permission to film first and remove private items from the frame."],
  },
  kfz: {
    label: "Car workshop", job: "automotive mechatronics technician", apprenticeship: "apprenticeship as an automotive technician", areas: ["Workshop", "Vehicle lift", "Customer reception"],
    activities: ["Vehicle diagnostics", "Tyre change", "Work on the lift"], product: "vehicle", tool: "diagnostic tester", outdoorWork: null,
    safety: ["Cover or avoid showing number plates of customer vehicles."],
  },
  bau: {
    label: "Construction", job: "bricklayer", apprenticeship: "apprenticeship as a bricklayer", areas: ["Depot", "Building site", "Office"],
    activities: ["Bricklaying", "Building formwork", "Working with the crane"], product: "building shell", tool: "trowel", outdoorWork: "Work on the building site",
    safety: ["Enter the site only with helmet and safety shoes, the film crew too.", "Ask the client or site manager for permission to film."],
  },
  baeckerei: {
    label: "Bakery", job: "baker", apprenticeship: "apprenticeship as a baker", areas: ["Bakehouse", "Bakehouse", "Shop"],
    activities: ["Kneading dough", "Taking bread out of the oven", "Early morning sales"], product: "loaf of bread", tool: "oven", outdoorWork: null,
    safety: ["Hygiene rules apply to the film crew too (hair net, clean clothes)."],
  },
  pflege: {
    label: "Care", job: "nurse", apprenticeship: "nursing training", areas: ["Ward", "Common room", "Office"],
    activities: ["Team handover", "Shared activity", "Documentation"], product: "everyday care", tool: "care documentation", outdoorWork: null,
    safety: ["Never film residents or patients without written consent; if in doubt, show only the team."],
  },
  gastro: {
    label: "Hospitality", job: "cook", apprenticeship: "apprenticeship as a cook", areas: ["Kitchen", "Kitchen", "Restaurant"],
    activities: ["Plating", "Serving guests", "Prep before service"], product: "dish", tool: "knife", outdoorWork: null,
    safety: ["Show guests only with consent; best film before opening."],
  },
  logistik: {
    label: "Logistics", job: "warehouse logistics specialist", apprenticeship: "apprenticeship in warehouse logistics", areas: ["Warehouse", "Loading bay", "Office"],
    activities: ["Order picking", "Forklift driving", "Loading"], product: "delivery", tool: "forklift", outdoorWork: "Loading",
    safety: ["Forklift traffic: film crew in hi-vis vests, agree on fixed positions."],
  },
};
/** The trade's texts in the requested language. */
export const tradeText = (t: Trade, lang: "de" | "en"): TradeText => (lang === "en" ? TRADES_EN[t.id] ?? t : t);

/** Best keyword match for a free-text industry, or null (neutral wording). */
export function matchTrade(industry: string | undefined): Trade | null {
  if (!industry) return null;
  const text = fold(industry);
  return TRADES.find(t => t.keywords.some(k => text.includes(k))) ?? null;
}
