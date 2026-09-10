// PROVISIONAL — hand-authored stand-in, not the output of `supabase gen types`.
// Docker was unavailable when G2 was authored, so `npx supabase gen types
// typescript --local` could not be run. This file mirrors the shape that
// command produces for the schema in supabase/migrations/000{1,2,3,4}_*.sql
// so src/db/client.ts can typecheck. It MUST be replaced by running:
//
//   npx supabase gen types typescript --local > src/db/types.ts
//
// against the local stack once Docker is available, and the file must not be
// hand-edited again after that — see docs/DATA-MODEL.md § Rules.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      areas: {
        Row: {
          id: string
          user_id: string
          geom: unknown
          dimension: string
          rating: number
          comment: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          geom: unknown
          dimension?: string
          rating: number
          comment?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          geom?: unknown
          dimension?: string
          rating?: number
          comment?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      area_cells: {
        Row: {
          area_id: string
          h3_index: string
          resolution: number
        }
        Insert: {
          area_id: string
          h3_index: string
          resolution?: number
        }
        Update: {
          area_id?: string
          h3_index?: string
          resolution?: number
        }
        Relationships: [
          {
            foreignKeyName: "area_cells_area_id_fkey"
            columns: ["area_id"]
            isOneToOne: false
            referencedRelation: "areas"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
