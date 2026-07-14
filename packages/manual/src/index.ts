import guide from "../guide.json" with { type: "json" };

export interface ManualSection {
  id: string;
  title: string;
  intro: string;
  steps: string[];
  notes: string[];
  links?: Array<{
    label: string;
    url: string;
  }>;
}

export interface UserGuide {
  title: string;
  version: string;
  updatedAt: string;
  summary: string;
  sections: ManualSection[];
}

export const userGuide = guide as UserGuide;
