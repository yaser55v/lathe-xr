export type Language = "it" | "en";

type LocalizedText = Record<Language, string>;

export type MediaCard = {
  kind: "image" | "video";
  title: LocalizedText;
  subtitle: LocalizedText;
};

type PartKnowledge = {
  partName: LocalizedText;
  machineContext: LocalizedText;
  fallback: {
    role: LocalizedText;
    operation: LocalizedText;
    useCase: LocalizedText;
  };
  media: MediaCard[];
};

export type AIResponse = {
  source: "fallback" | "live";
  text: string;
  media: MediaCard[];
};

const REQUEST_TIMEOUT_MS = 2500;
const MAX_RESPONSE_WORDS = 80;

const partKnowledge: Record<string, PartKnowledge> = {
  Object_179: {
    partName: {
      it: "Apron / Handwheel",
      en: "Apron / Handwheel",
    },
    machineContext: {
      it: "tornio da banco per lavorazioni industriali leggere",
      en: "bench lathe for light industrial machining",
    },
    fallback: {
      role: {
        it: "Questa manovella governa l'avanzamento manuale del carro. Permette di posizionare l'utensile con controllo diretto quando serve precisione prima o durante la lavorazione.",
        en: "This handwheel controls the carriage manually. It lets the operator position the tool directly when precise setup or correction is needed during machining.",
      },
      operation: {
        it: "Il movimento della ruota viene trasmesso al meccanismo dell'apron e convertito in avanzamento lineare del carro lungo il bancale. In pratica collega gesto manuale e spostamento controllato dell'utensile.",
        en: "The wheel motion is transferred into the apron mechanism and converted into linear carriage travel along the bed. In practice it links manual input to controlled tool movement.",
      },
      useCase: {
        it: "Un uso tipico e avvicinare lentamente l'utensile al pezzo per una regolazione finale o per controllare l'inizio della passata prima di affidarsi all'avanzamento automaticو.",
        en: "A typical use case is bringing the tool slowly toward the workpiece for final adjustment or checking the start of a cut before switching to automatic feed.",
      },
    },
    media: [
      {
        kind: "image",
        title: {
          it: "Vista esplosa dell'apron",
          en: "Exploded apron view",
        },
        subtitle: {
          it: "Schema rapido dei collegamenti tra ruota, ingranaggi e carro.",
          en: "Quick diagram of the wheel, gear train, and carriage linkage.",
        },
      },
      {
        kind: "video",
        title: {
          it: "Clip del movimento del carro",
          en: "Carriage motion clip",
        },
        subtitle: {
          it: "Breve riferimento sul comportamento del feed durante l'avanzamento.",
          en: "Short reference showing feed behavior during carriage travel.",
        },
      },
    ],
  },
};

function sanitizeForXR(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x00-\x7F]/g, " ");
}

export function getSupportedLanguage(language: string | undefined): Language {
  return language === "en" ? "en" : "it";
}

export function getPartKnowledge(partId: string) {
  return partKnowledge[partId] ?? partKnowledge.Object_179;
}

export function getInstantExplanation(
  partId: string,
  language: Language,
  question: string,
): AIResponse {
  const knowledge = getPartKnowledge(partId);

  return {
    source: "fallback",
    text: sanitizeForXR(buildFallbackAnswer(knowledge, language, question)),
    media: shouldAttachMedia(question, language) ? knowledge.media : [],
  };
}

export async function getAIExplanation(
  partId: string,
  language: Language,
  question: string,
): Promise<AIResponse | null> {
  const apiKey = (import.meta as any).env?.VITE_GROQ_API_KEY;

  if (!apiKey) return null;

  const knowledge = getPartKnowledge(partId);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "meta-llama/llama-3.1-70b-versatile",
        temperature: 0.35,
        max_tokens: 140,
        messages: [
          {
            role: "system",
            content: "You explain industrial machine parts. Keep answers short and under 80 words.",
          },
          {
            role: "user",
            content: `Part: ${knowledge.partName[language]}. Question: ${question}. Language: ${language}`,
          },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    return {
      source: "live",
      text: sanitizeForXR(trimToWordLimit(text, MAX_RESPONSE_WORDS)),
      media: shouldAttachMedia(question, language) ? knowledge.media : [],
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function buildFallbackAnswer(knowledge: PartKnowledge, language: Language, question: string) {
  const normalized = question.toLowerCase();
  if (normalized.includes("work") || normalized.includes("how") || normalized.includes("funz")) {
    return knowledge.fallback.operation[language];
  }
  if (normalized.includes("use") || normalized.includes("case") || normalized.includes("serve")) {
    return knowledge.fallback.useCase[language];
  }
  return knowledge.fallback.role[language];
}

function shouldAttachMedia(question: string, language: Language) {
  const normalized = question.toLowerCase();
  const mediaKeywords = language === "it"
    ? ["mostra", "schema", "immagine", "video"]
    : ["show", "diagram", "image", "video"];
  return mediaKeywords.some((keyword) => normalized.includes(keyword));
}

function trimToWordLimit(text: string, maxWords: number) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  return words.length <= maxWords ? text.trim() : `${words.slice(0, maxWords).join(" ")}...`;
}