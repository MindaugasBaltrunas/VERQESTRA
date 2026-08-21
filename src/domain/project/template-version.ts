// Šablonų versijos GRYNOSIOS taisyklės (etalonas: AG_loop orchestrator/runtime/
// template-version.ts parse/compare pusė). Domain sluoksnis: jokio FS — VERSION failo
// skaitymas gyvena `install` komandos portuose, o čia lieka tik forma ir palyginimas.

export type TemplateVersion = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

export type TemplateVersionRelation = "behind" | "current" | "ahead";

export type TemplateVersionComparison = {
  installed: TemplateVersion;
  current: TemplateVersion;
  relation: TemplateVersionRelation;
};

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Neatpažinta versija yra KLAIDA, niekada tylus default'as: numanoma „0.0.0" paverstų bet kokį
 * sugadintą VERSION failą į „atsilieka" ir siūlytų perrašyti failus, kurių niekas nelygino.
 */
export function parseTemplateVersion(raw: string): TemplateVersion {
  const value = raw.trim();
  const match = VERSION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid template version "${value}". Expected MAJOR.MINOR.PATCH.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: value,
  };
}

export function compareTemplateVersions(installedRaw: string, currentRaw: string): TemplateVersionComparison {
  const installed = parseTemplateVersion(installedRaw);
  const current = parseTemplateVersion(currentRaw);
  const installedParts = [installed.major, installed.minor, installed.patch];
  const currentParts = [current.major, current.minor, current.patch];

  for (let index = 0; index < installedParts.length; index += 1) {
    const installedPart = installedParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (installedPart < currentPart) return { installed, current, relation: "behind" };
    if (installedPart > currentPart) return { installed, current, relation: "ahead" };
  }

  return { installed, current, relation: "current" };
}
