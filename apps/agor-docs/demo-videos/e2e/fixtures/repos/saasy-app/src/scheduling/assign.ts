export interface Job {
  id: string;
  window: { start: Date; end: Date };
  skills: string[];
}

export interface Technician {
  id: string;
  skills: string[];
  bookedUntil: Date;
}

/** Pick the first free technician with every skill the job needs. */
export function assign(job: Job, techs: Technician[]): Technician | undefined {
  return techs.find(
    (t) => t.bookedUntil <= job.window.start && job.skills.every((s) => t.skills.includes(s))
  );
}
