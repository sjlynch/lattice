export type DirEntry = {
  name: string;
  path: string;
};

export type DirRoot = {
  name: string;
  path: string;
};

export type DirListing = {
  path: string;
  parent: string | null;
  roots: DirRoot[];
  entries: DirEntry[];
};
