export type Incident = {
  incident_id: string;
  key: string;
  title: string;
  path: string;
  first_seen: number;
  opened_at: number | null;
  resolved_at: number | null;
};
