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
    id: "metallbau", label: "Metallbau", keywords: ["metallbau", "metall", "schlosser", "stahlbau", "schweiss"],
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
    id: "zimmerei", label: "Zimmerei", keywords: ["zimmerei", "zimmerer", "dach", "dachdecker", "holzbau"],
    job: "Zimmerer/Zimmerin", apprenticeship: "Ausbildung zum Zimmerer (m/w/d)", areas: ["Abbundhalle", "Abbundhalle", "Büro"],
    activities: ["Abbund", "Dachstuhl aufrichten", "Arbeiten in der Höhe"], product: "Dachstuhl", tool: "Kettensäge",
    outdoorWork: "Dachstuhl aufrichten",
    safety: ["Höhenaufnahmen nur mit Absturzsicherung; das Filmteam bleibt am Boden oder gesichert."],
  },
  {
    id: "schreinerei", label: "Schreinerei", keywords: ["schreiner", "tischler", "holz", "moebel", "mobel"],
    job: "Schreiner:in", apprenticeship: "Ausbildung zum Schreiner (m/w/d)", areas: ["Werkstatt", "Maschinenraum", "Büro"],
    activities: ["Zuschnitt", "Oberflächenbehandlung", "Montage beim Kunden"], product: "Möbelstück", tool: "Formatkreissäge",
    outdoorWork: "Montage beim Kunden",
    safety: ["Absaugung und Gehörschutz im Bild beachten.", "Für Interviews die Maschinen abschalten lassen."],
  },
  {
    id: "elektro", label: "Elektrotechnik", keywords: ["elektro", "elektriker", "elektronik"],
    job: "Elektroniker:in", apprenticeship: "Ausbildung zum Elektroniker (m/w/d)", areas: ["Werkstatt", "Schaltschrankbau", "Büro"],
    activities: ["Verdrahtung im Schaltschrank", "Installation auf der Baustelle", "Fehlersuche mit Messgerät"], product: "Schaltschrank", tool: "Messgerät",
    outdoorWork: "Installation auf der Baustelle",
    safety: ["Nur an freigeschalteten Anlagen filmen; keine Arbeiten unter Spannung inszenieren."],
  },
  {
    id: "shk", label: "Sanitär, Heizung, Klima", keywords: ["shk", "sanitaer", "sanitar", "heizung", "klima", "installateur"],
    job: "Anlagenmechaniker:in SHK", apprenticeship: "Ausbildung zum Anlagenmechaniker SHK (m/w/d)", areas: ["Werkstatt", "Werkstatt", "Büro"],
    activities: ["Rohre verpressen", "Heizung einbauen", "Wartung beim Kunden"], product: "Heizungsanlage", tool: "Pressmaschine",
    outdoorWork: "Wartung beim Kunden",
    safety: ["Beim Kunden vorher die Drehgenehmigung einholen und private Gegenstände aus dem Bild nehmen."],
  },
  {
    id: "kfz", label: "Kfz-Werkstatt", keywords: ["kfz", "autohaus", "autowerkstatt", "mechatroniker", "karosserie"],
    job: "Kfz-Mechatroniker:in", apprenticeship: "Ausbildung zum Kfz-Mechatroniker (m/w/d)", areas: ["Werkstatt", "Hebebühne", "Kundenannahme"],
    activities: ["Diagnose am Fahrzeug", "Reifenwechsel", "Arbeiten an der Hebebühne"], product: "Fahrzeug", tool: "Diagnosegerät",
    outdoorWork: null,
    safety: ["Kennzeichen von Kundenfahrzeugen abdecken oder nicht zeigen."],
  },
  {
    id: "bau", label: "Bau", keywords: ["bauunternehmen", "baufirma", "maurer", "hochbau", "tiefbau", "beton"],
    job: "Maurer:in", apprenticeship: "Ausbildung zum Maurer (m/w/d)", areas: ["Bauhof", "Baustelle", "Büro"],
    activities: ["Mauern", "Schalung bauen", "Arbeiten mit dem Kran"], product: "Rohbau", tool: "Kelle",
    outdoorWork: "Arbeiten auf der Baustelle",
    safety: ["Baustelle nur mit Helm und Sicherheitsschuhen betreten, auch das Filmteam.", "Bauherr bzw. Bauleitung um Drehgenehmigung bitten."],
  },
  {
    id: "baeckerei", label: "Bäckerei", keywords: ["baecker", "backer", "baeckerei", "konditor"],
    job: "Bäcker:in", apprenticeship: "Ausbildung zum Bäcker (m/w/d)", areas: ["Backstube", "Backstube", "Verkauf"],
    activities: ["Teig kneten", "Brot aus dem Ofen holen", "Verkauf am Morgen"], product: "Brot", tool: "Ofen",
    outdoorWork: null,
    safety: ["Hygienevorschriften auch für das Filmteam (Haube, saubere Kleidung)."],
  },
  {
    id: "pflege", label: "Pflege", keywords: ["pflegedienst", "pflegeheim", "altenpflege", "krankenpflege", "pflegefach", "altenheim", "krankenhaus", "klinik", "senioren"],
    job: "Pflegefachkraft", apprenticeship: "Ausbildung zur Pflegefachkraft (m/w/d)", areas: ["Station", "Aufenthaltsraum", "Büro"],
    activities: ["Übergabe im Team", "Gemeinsame Aktivität", "Dokumentation"], product: "Pflegealltag", tool: "Pflegedokumentation",
    outdoorWork: null,
    safety: ["Keine Bewohner oder Patienten ohne schriftliche Einwilligung filmen; im Zweifel nur das Team zeigen."],
  },
  {
    id: "gastro", label: "Gastronomie und Hotel", keywords: ["gastro", "hotel", "restaurant", "koch", "kueche", "kuche"],
    job: "Koch/Köchin", apprenticeship: "Ausbildung zum Koch (m/w/d)", areas: ["Küche", "Küche", "Restaurant"],
    activities: ["Anrichten", "Service am Gast", "Vorbereitung vor dem Service"], product: "Gericht", tool: "Messer",
    outdoorWork: null,
    safety: ["Gäste nur mit Einwilligung zeigen; am besten vor der Öffnung drehen."],
  },
  {
    id: "logistik", label: "Logistik", keywords: ["logistik", "lager", "spedition", "transport", "versand"],
    job: "Fachkraft für Lagerlogistik", apprenticeship: "Ausbildung zur Fachkraft für Lagerlogistik (m/w/d)", areas: ["Lager", "Verladung", "Büro"],
    activities: ["Kommissionieren", "Staplerfahren", "Verladen"], product: "Lieferung", tool: "Gabelstapler",
    outdoorWork: "Verladen",
    safety: ["Staplerverkehr: Filmteam mit Warnweste, feste Standorte absprechen."],
  },
];

const fold = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");

/** Best keyword match for a free-text industry, or null (neutral wording). */
export function matchTrade(industry: string | undefined): Trade | null {
  if (!industry) return null;
  const text = fold(industry);
  return TRADES.find(t => t.keywords.some(k => text.includes(k))) ?? null;
}
