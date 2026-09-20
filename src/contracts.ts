export interface RawLink {
  href: string;
  label: string;
  visible: boolean;
  download: boolean;
}

export interface RawPageSnapshot {
  url: string;
  title: string;
  text: string;
  links: RawLink[];
}

export interface LinkCandidate {
  id: string;
  label: string;
  url: string;
  publicUrl: string;
  fingerprint: string;
}

export interface PageSnapshot {
  sourceUrl: string;
  publicUrl: string;
  title: string;
  text: string;
  candidates: LinkCandidate[];
}
