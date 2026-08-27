export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      admin_settings: {
        Row: {
          created_at: string | null;
          description: string | null;
          id: string;
          key: string;
          updated_at: string | null;
          updated_by: string | null;
          value: Json;
        };
        Insert: {
          created_at?: string | null;
          description?: string | null;
          id?: string;
          key: string;
          updated_at?: string | null;
          updated_by?: string | null;
          value: Json;
        };
        Update: {
          created_at?: string | null;
          description?: string | null;
          id?: string;
          key?: string;
          updated_at?: string | null;
          updated_by?: string | null;
          value?: Json;
        };
        Relationships: [];
      };
      attempts: {
        Row: {
          cause: string | null;
          confidence: number | null;
          created_at: string;
          id: string;
          is_correct: boolean | null;
          is_self_assessed: boolean;
          part_results: Json;
          problem_id: string;
          reflection_notes: string | null;
          selected_status: string | null;
          submitted_answer: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          cause?: string | null;
          confidence?: number | null;
          created_at?: string;
          id?: string;
          is_correct?: boolean | null;
          is_self_assessed?: boolean;
          part_results?: Json;
          problem_id: string;
          reflection_notes?: string | null;
          selected_status?: string | null;
          submitted_answer: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          cause?: string | null;
          confidence?: number | null;
          created_at?: string;
          id?: string;
          is_correct?: boolean | null;
          is_self_assessed?: boolean;
          part_results?: Json;
          problem_id?: string;
          reflection_notes?: string | null;
          selected_status?: string | null;
          submitted_answer?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'attempts_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
        ];
      };
      canonical_subjects: {
        Row: {
          aliases: string[];
          created_at: string;
          name: string;
          stable_key: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          aliases?: string[];
          created_at?: string;
          name: string;
          stable_key: string;
          status: string;
          updated_at?: string;
        };
        Update: {
          aliases?: string[];
          created_at?: string;
          name?: string;
          stable_key?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      content_limit_overrides: {
        Row: {
          created_at: string;
          id: string;
          limit_value: number;
          resource_type: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          limit_value: number;
          resource_type: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          limit_value?: number;
          resource_type?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      device_claims: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          boot_id: string;
          capabilities: Json;
          consumed_at: string | null;
          created_at: string;
          device_id: string | null;
          device_public_key: string | null;
          display_code: string | null;
          display_code_hash: string | null;
          expires_at: string;
          firmware_version: string;
          hardware_id: string;
          id: string;
          poll_interval_ms: number;
          request_id: string;
          sealed_credential: Json | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          boot_id: string;
          capabilities?: Json;
          consumed_at?: string | null;
          created_at?: string;
          device_id?: string | null;
          device_public_key?: string | null;
          display_code?: string | null;
          display_code_hash?: string | null;
          expires_at: string;
          firmware_version: string;
          hardware_id: string;
          id?: string;
          poll_interval_ms?: number;
          request_id: string;
          sealed_credential?: Json | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          boot_id?: string;
          capabilities?: Json;
          consumed_at?: string | null;
          created_at?: string;
          device_id?: string | null;
          device_public_key?: string | null;
          display_code?: string | null;
          display_code_hash?: string | null;
          expires_at?: string;
          firmware_version?: string;
          hardware_id?: string;
          id?: string;
          poll_interval_ms?: number;
          request_id?: string;
          sealed_credential?: Json | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'device_claims_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'esp32_devices';
            referencedColumns: ['id'];
          },
        ];
      };
      device_content_revisions: {
        Row: {
          domain: string;
          revision: number;
          scope_key: string;
          updated_at: string;
        };
        Insert: {
          domain: string;
          revision?: number;
          scope_key: string;
          updated_at?: string;
        };
        Update: {
          domain?: string;
          revision?: number;
          scope_key?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      device_image_artifacts: {
        Row: {
          created_at: string;
          image_id: string;
          last_seen_at: string;
          pixel_format: string;
          storage_path: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          image_id: string;
          last_seen_at?: string;
          pixel_format: string;
          storage_path: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          image_id?: string;
          last_seen_at?: string;
          pixel_format?: string;
          storage_path?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      device_pack_artifacts: {
        Row: {
          byte_size: number;
          created_at: string;
          domain: string;
          last_seen_at: string;
          logical_id: string;
          revision: number;
          sha256: string;
          storage_path: string;
          user_id: string;
        };
        Insert: {
          byte_size: number;
          created_at?: string;
          domain: string;
          last_seen_at?: string;
          logical_id: string;
          revision: number;
          sha256: string;
          storage_path: string;
          user_id: string;
        };
        Update: {
          byte_size?: number;
          created_at?: string;
          domain?: string;
          last_seen_at?: string;
          logical_id?: string;
          revision?: number;
          sha256?: string;
          storage_path?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      error_categorisations: {
        Row: {
          ai_confidence: number;
          ai_reasoning: string | null;
          attempt_id: string;
          broad_category: string;
          created_at: string;
          granular_tag: string;
          id: string;
          is_user_override: boolean;
          original_broad_category: string | null;
          original_granular_tag: string | null;
          part_index: number | null;
          problem_id: string;
          subject_id: string;
          topic_label: string;
          topic_label_normalised: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          ai_confidence: number;
          ai_reasoning?: string | null;
          attempt_id: string;
          broad_category: string;
          created_at?: string;
          granular_tag: string;
          id?: string;
          is_user_override?: boolean;
          original_broad_category?: string | null;
          original_granular_tag?: string | null;
          part_index?: number | null;
          problem_id: string;
          subject_id: string;
          topic_label: string;
          topic_label_normalised: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          ai_confidence?: number;
          ai_reasoning?: string | null;
          attempt_id?: string;
          broad_category?: string;
          created_at?: string;
          granular_tag?: string;
          id?: string;
          is_user_override?: boolean;
          original_broad_category?: string | null;
          original_granular_tag?: string | null;
          part_index?: number | null;
          problem_id?: string;
          subject_id?: string;
          topic_label?: string;
          topic_label_normalised?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'error_categorisations_attempt_id_fkey';
            columns: ['attempt_id'];
            isOneToOne: true;
            referencedRelation: 'attempts';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'error_categorisations_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'error_categorisations_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
        ];
      };
      esp32_ai_conversations: {
        Row: {
          conversation_id: string;
          created_at: string;
          device_id: string | null;
          id: string;
          last_turn_at: string;
          tier: string;
          title: string | null;
          turns: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          conversation_id: string;
          created_at?: string;
          device_id?: string | null;
          id?: string;
          last_turn_at?: string;
          tier?: string;
          title?: string | null;
          turns?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          conversation_id?: string;
          created_at?: string;
          device_id?: string | null;
          id?: string;
          last_turn_at?: string;
          tier?: string;
          title?: string | null;
          turns?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      esp32_devices: {
        Row: {
          access_token_hash: string;
          auto_sync_interval_minutes: number;
          config_revision: number;
          created_at: string | null;
          device_name: string | null;
          firmware_version: string | null;
          flash_session_expires_at: string | null;
          flash_session_id: string | null;
          hardware_id: string | null;
          id: string;
          last_boot_id: string | null;
          last_protocol_version: string;
          last_seen_at: string | null;
          last_sync_at: string | null;
          mac_address: string;
          preferred_tier: string;
          protocol_capabilities: Json;
          sync_cursor: number;
          user_id: string;
        };
        Insert: {
          access_token_hash: string;
          auto_sync_interval_minutes?: number;
          config_revision?: number;
          created_at?: string | null;
          device_name?: string | null;
          firmware_version?: string | null;
          flash_session_expires_at?: string | null;
          flash_session_id?: string | null;
          hardware_id?: string | null;
          id?: string;
          last_boot_id?: string | null;
          last_protocol_version?: string;
          last_seen_at?: string | null;
          last_sync_at?: string | null;
          mac_address: string;
          preferred_tier?: string;
          protocol_capabilities?: Json;
          sync_cursor?: number;
          user_id: string;
        };
        Update: {
          access_token_hash?: string;
          auto_sync_interval_minutes?: number;
          config_revision?: number;
          created_at?: string | null;
          device_name?: string | null;
          firmware_version?: string | null;
          flash_session_expires_at?: string | null;
          flash_session_id?: string | null;
          hardware_id?: string | null;
          id?: string;
          last_boot_id?: string | null;
          last_protocol_version?: string;
          last_seen_at?: string | null;
          last_sync_at?: string | null;
          mac_address?: string;
          preferred_tier?: string;
          protocol_capabilities?: Json;
          sync_cursor?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      esp32_pairing_pending: {
        Row: {
          created_at: string | null;
          device_name: string | null;
          mac_address: string;
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          device_name?: string | null;
          mac_address: string;
          user_id: string;
        };
        Update: {
          created_at?: string | null;
          device_name?: string | null;
          mac_address?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      esp32_request_idempotency: {
        Row: {
          created_at: string;
          device_id: string;
          endpoint: string;
          expires_at: string;
          http_status: number;
          request_fingerprint: string;
          request_id: string;
          response_body: Json;
        };
        Insert: {
          created_at?: string;
          device_id: string;
          endpoint: string;
          expires_at?: string;
          http_status: number;
          request_fingerprint: string;
          request_id: string;
          response_body: Json;
        };
        Update: {
          created_at?: string;
          device_id?: string;
          endpoint?: string;
          expires_at?: string;
          http_status?: number;
          request_fingerprint?: string;
          request_id?: string;
          response_body?: Json;
        };
        Relationships: [
          {
            foreignKeyName: 'esp32_request_idempotency_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'esp32_devices';
            referencedColumns: ['id'];
          },
        ];
      };
      fsrs_authority_cutover_snapshots: {
        Row: {
          created_at: string;
          cutover_id: string;
          fsrs_projection_revision: number;
          previous_authority_algorithm: string | null;
          previous_authority_parameter_set_id: string | null;
          previous_authority_projection_revision: number | null;
          previous_ease_factor: number | null;
          previous_interval_days: number | null;
          previous_last_reviewed_at: string | null;
          previous_next_review_at: string | null;
          previous_repetition_number: number | null;
          problem_id: string;
          schedule_existed: boolean;
          timeline_event_count: number;
          timeline_fingerprint: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          cutover_id: string;
          fsrs_projection_revision: number;
          previous_authority_algorithm?: string | null;
          previous_authority_parameter_set_id?: string | null;
          previous_authority_projection_revision?: number | null;
          previous_ease_factor?: number | null;
          previous_interval_days?: number | null;
          previous_last_reviewed_at?: string | null;
          previous_next_review_at?: string | null;
          previous_repetition_number?: number | null;
          problem_id: string;
          schedule_existed: boolean;
          timeline_event_count: number;
          timeline_fingerprint: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          cutover_id?: string;
          fsrs_projection_revision?: number;
          previous_authority_algorithm?: string | null;
          previous_authority_parameter_set_id?: string | null;
          previous_authority_projection_revision?: number | null;
          previous_ease_factor?: number | null;
          previous_interval_days?: number | null;
          previous_last_reviewed_at?: string | null;
          previous_next_review_at?: string | null;
          previous_repetition_number?: number | null;
          problem_id?: string;
          schedule_existed?: boolean;
          timeline_event_count?: number;
          timeline_fingerprint?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'fsrs_authority_cutover_snapshots_cutover_id_fkey';
            columns: ['cutover_id'];
            isOneToOne: false;
            referencedRelation: 'fsrs_authority_cutovers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'fsrs_authority_cutover_snapshots_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      fsrs_authority_cutovers: {
        Row: {
          cancelled_at: string | null;
          cutover_at: string;
          id: string;
          problem_count: number;
          status: string;
          user_id: string;
        };
        Insert: {
          cancelled_at?: string | null;
          cutover_at?: string;
          id?: string;
          problem_count: number;
          status?: string;
          user_id: string;
        };
        Update: {
          cancelled_at?: string | null;
          cutover_at?: string;
          id?: string;
          problem_count?: number;
          status?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      fsrs_parameter_sets: {
        Row: {
          algorithm_version: string;
          config_hash: string;
          created_at: string;
          id: string;
          library_name: string;
          library_version: string;
          parameters: Json;
          stable_key: string;
        };
        Insert: {
          algorithm_version: string;
          config_hash: string;
          created_at?: string;
          id: string;
          library_name: string;
          library_version: string;
          parameters: Json;
          stable_key: string;
        };
        Update: {
          algorithm_version?: string;
          config_hash?: string;
          created_at?: string;
          id?: string;
          library_name?: string;
          library_version?: string;
          parameters?: Json;
          stable_key?: string;
        };
        Relationships: [];
      };
      fsrs_review_schedule_projection: {
        Row: {
          calculated_parameter_set_id: string | null;
          card_initialized: boolean;
          difficulty: number | null;
          fsrs_state: string | null;
          lapses: number | null;
          last_application_id: string | null;
          last_event_id: string | null;
          last_reviewed_at: string | null;
          learning_step_index: number | null;
          library_name: string;
          library_version: string;
          next_review_at: string | null;
          problem_id: string;
          projection_revision: number;
          reps: number | null;
          scheduled_days: number | null;
          scheduler_algorithm: string;
          stability: number | null;
          timeline_event_count: number;
          timeline_fingerprint: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          calculated_parameter_set_id?: string | null;
          card_initialized: boolean;
          difficulty?: number | null;
          fsrs_state?: string | null;
          lapses?: number | null;
          last_application_id?: string | null;
          last_event_id?: string | null;
          last_reviewed_at?: string | null;
          learning_step_index?: number | null;
          library_name?: string;
          library_version?: string;
          next_review_at?: string | null;
          problem_id: string;
          projection_revision: number;
          reps?: number | null;
          scheduled_days?: number | null;
          scheduler_algorithm?: string;
          stability?: number | null;
          timeline_event_count: number;
          timeline_fingerprint: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          calculated_parameter_set_id?: string | null;
          card_initialized?: boolean;
          difficulty?: number | null;
          fsrs_state?: string | null;
          lapses?: number | null;
          last_application_id?: string | null;
          last_event_id?: string | null;
          last_reviewed_at?: string | null;
          learning_step_index?: number | null;
          library_name?: string;
          library_version?: string;
          next_review_at?: string | null;
          problem_id?: string;
          projection_revision?: number;
          reps?: number | null;
          scheduled_days?: number | null;
          scheduler_algorithm?: string;
          stability?: number | null;
          timeline_event_count?: number;
          timeline_fingerprint?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'fsrs_review_schedule_projectio_calculated_parameter_set_id_fkey';
            columns: ['calculated_parameter_set_id'];
            isOneToOne: false;
            referencedRelation: 'fsrs_parameter_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'fsrs_review_schedule_projection_last_application_id_fkey';
            columns: ['last_application_id'];
            isOneToOne: false;
            referencedRelation: 'problem_review_schedule_applications';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'fsrs_review_schedule_projection_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      insight_digests: {
        Row: {
          created_at: string;
          digest_tier: string | null;
          error_pattern_summary: string;
          generated_at: string;
          headline: string;
          id: string;
          progress_narratives: Json;
          raw_aggregation_data: Json | null;
          status: string;
          subject_error_patterns: Json | null;
          subject_health: Json;
          topic_clusters: Json;
          user_id: string;
          weak_spots: Json;
        };
        Insert: {
          created_at?: string;
          digest_tier?: string | null;
          error_pattern_summary?: string;
          generated_at?: string;
          headline?: string;
          id?: string;
          progress_narratives?: Json;
          raw_aggregation_data?: Json | null;
          status?: string;
          subject_error_patterns?: Json | null;
          subject_health?: Json;
          topic_clusters?: Json;
          user_id: string;
          weak_spots?: Json;
        };
        Update: {
          created_at?: string;
          digest_tier?: string | null;
          error_pattern_summary?: string;
          generated_at?: string;
          headline?: string;
          id?: string;
          progress_narratives?: Json;
          raw_aggregation_data?: Json | null;
          status?: string;
          subject_error_patterns?: Json | null;
          subject_health?: Json;
          topic_clusters?: Json;
          user_id?: string;
          weak_spots?: Json;
        };
        Relationships: [];
      };
      knowledge_marks: {
        Row: {
          aliases: string[];
          created_at: string;
          description: string | null;
          exclude_notes: string[];
          include_notes: string[];
          kind: string;
          name: string;
          parent_key: string | null;
          stable_key: string;
          status: string;
          subject_key: string;
          updated_at: string;
        };
        Insert: {
          aliases?: string[];
          created_at?: string;
          description?: string | null;
          exclude_notes?: string[];
          include_notes?: string[];
          kind: string;
          name: string;
          parent_key?: string | null;
          stable_key: string;
          status: string;
          subject_key: string;
          updated_at?: string;
        };
        Update: {
          aliases?: string[];
          created_at?: string;
          description?: string | null;
          exclude_notes?: string[];
          include_notes?: string[];
          kind?: string;
          name?: string;
          parent_key?: string | null;
          stable_key?: string;
          status?: string;
          subject_key?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'knowledge_marks_parent_fkey';
            columns: ['parent_key', 'subject_key', 'kind'];
            isOneToOne: false;
            referencedRelation: 'knowledge_marks';
            referencedColumns: ['stable_key', 'subject_key', 'kind'];
          },
          {
            foreignKeyName: 'knowledge_marks_subject_key_fkey';
            columns: ['subject_key'];
            isOneToOne: false;
            referencedRelation: 'canonical_subjects';
            referencedColumns: ['stable_key'];
          },
        ];
      };
      knowledge_registry_revisions: {
        Row: {
          applied: boolean;
          completed_at: string;
          content_sha256: string;
          id: number;
          mark_count: number;
          schema_version: number;
          source_repository: string;
          source_sha: string;
          subject_count: number;
        };
        Insert: {
          applied: boolean;
          completed_at?: string;
          content_sha256: string;
          id?: never;
          mark_count: number;
          schema_version: number;
          source_repository: string;
          source_sha: string;
          subject_count: number;
        };
        Update: {
          applied?: boolean;
          completed_at?: string;
          content_sha256?: string;
          id?: never;
          mark_count?: number;
          schema_version?: number;
          source_repository?: string;
          source_sha?: string;
          subject_count?: number;
        };
        Relationships: [];
      };
      knowledge_registry_state: {
        Row: {
          active_revision_id: number;
          singleton: boolean;
          updated_at: string;
        };
        Insert: {
          active_revision_id: number;
          singleton?: boolean;
          updated_at?: string;
        };
        Update: {
          active_revision_id?: number;
          singleton?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'knowledge_registry_state_active_revision_id_fkey';
            columns: ['active_revision_id'];
            isOneToOne: false;
            referencedRelation: 'knowledge_registry_revisions';
            referencedColumns: ['id'];
          },
        ];
      };
      note_change_log: {
        Row: {
          change_seq: number;
          changed_at: string;
          id: number;
          note_id: string;
          notebook_id: string;
          operation: string;
          revision: number;
          user_id: string;
        };
        Insert: {
          change_seq: number;
          changed_at?: string;
          id?: never;
          note_id: string;
          notebook_id: string;
          operation: string;
          revision: number;
          user_id: string;
        };
        Update: {
          change_seq?: number;
          changed_at?: string;
          id?: never;
          note_id?: string;
          notebook_id?: string;
          operation?: string;
          revision?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      note_read_state: {
        Row: {
          completed_count: number;
          last_completed_at: string | null;
          last_opened_at: string | null;
          note_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          completed_count?: number;
          last_completed_at?: string | null;
          last_opened_at?: string | null;
          note_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          completed_count?: number;
          last_completed_at?: string | null;
          last_opened_at?: string | null;
          note_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'note_read_state_note_id_fkey';
            columns: ['note_id'];
            isOneToOne: false;
            referencedRelation: 'notebook_notes';
            referencedColumns: ['id'];
          },
        ];
      };
      notebook_ai_access: {
        Row: {
          can_create: boolean;
          can_read: boolean;
          can_update: boolean;
          created_at: string;
          id: string;
          notebook_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          can_create?: boolean;
          can_read?: boolean;
          can_update?: boolean;
          created_at?: string;
          id?: string;
          notebook_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          can_create?: boolean;
          can_read?: boolean;
          can_update?: boolean;
          created_at?: string;
          id?: string;
          notebook_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notebook_ai_access_notebook_id_fkey';
            columns: ['notebook_id'];
            isOneToOne: false;
            referencedRelation: 'notebooks';
            referencedColumns: ['id'];
          },
        ];
      };
      notebook_ai_audit_log: {
        Row: {
          content_sha256: string;
          conversation_id: string | null;
          created_at: string;
          id: number;
          linked_problem_id: string | null;
          note_id: string;
          notebook_id: string;
          title: string;
          user_id: string;
        };
        Insert: {
          content_sha256: string;
          conversation_id?: string | null;
          created_at?: string;
          id?: never;
          linked_problem_id?: string | null;
          note_id: string;
          notebook_id: string;
          title: string;
          user_id: string;
        };
        Update: {
          content_sha256?: string;
          conversation_id?: string | null;
          created_at?: string;
          id?: never;
          linked_problem_id?: string | null;
          note_id?: string;
          notebook_id?: string;
          title?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      notebook_notes: {
        Row: {
          archived_at: string | null;
          assets: Json;
          client_request_id: string | null;
          content: string;
          content_format: string;
          created_at: string;
          id: string;
          linked_problem_id: string | null;
          metadata: Json;
          notebook_id: string;
          revision: number;
          sort_index: number;
          source: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          archived_at?: string | null;
          assets?: Json;
          client_request_id?: string | null;
          content: string;
          content_format?: string;
          created_at?: string;
          id?: string;
          linked_problem_id?: string | null;
          metadata?: Json;
          notebook_id: string;
          revision?: number;
          sort_index?: number;
          source?: string;
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          archived_at?: string | null;
          assets?: Json;
          client_request_id?: string | null;
          content?: string;
          content_format?: string;
          created_at?: string;
          id?: string;
          linked_problem_id?: string | null;
          metadata?: Json;
          notebook_id?: string;
          revision?: number;
          sort_index?: number;
          source?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notebook_notes_linked_problem_id_fkey';
            columns: ['linked_problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notebook_notes_notebook_id_fkey';
            columns: ['notebook_id'];
            isOneToOne: false;
            referencedRelation: 'notebooks';
            referencedColumns: ['id'];
          },
        ];
      };
      notebooks: {
        Row: {
          archived_at: string | null;
          color: string | null;
          created_at: string;
          description: string | null;
          icon: string | null;
          id: string;
          revision: number;
          subject_id: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          archived_at?: string | null;
          color?: string | null;
          created_at?: string;
          description?: string | null;
          icon?: string | null;
          id?: string;
          revision?: number;
          subject_id: string;
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          archived_at?: string | null;
          color?: string | null;
          created_at?: string;
          description?: string | null;
          icon?: string | null;
          id?: string;
          revision?: number;
          subject_id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notebooks_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_initial_idea_mcp_challenges: {
        Row: {
          challenge_token_hash: string;
          consumed_at: string | null;
          consumed_revision_id: string | null;
          created_at: string;
          exact_text_hash: string;
          expires_at: string;
          id: string;
          problem_id: string;
          proposed_idea: string;
          source_api_token_id: string;
          source_request_id: string;
          user_id: string;
        };
        Insert: {
          challenge_token_hash: string;
          consumed_at?: string | null;
          consumed_revision_id?: string | null;
          created_at?: string;
          exact_text_hash: string;
          expires_at: string;
          id?: string;
          problem_id: string;
          proposed_idea: string;
          source_api_token_id: string;
          source_request_id: string;
          user_id: string;
        };
        Update: {
          challenge_token_hash?: string;
          consumed_at?: string | null;
          consumed_revision_id?: string | null;
          created_at?: string;
          exact_text_hash?: string;
          expires_at?: string;
          id?: string;
          problem_id?: string;
          proposed_idea?: string;
          source_api_token_id?: string;
          source_request_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_initial_idea_mcp_challenges_consumed_revision_fkey';
            columns: ['consumed_revision_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'problem_initial_idea_revisions';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_initial_idea_mcp_challenges_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'problem_initial_idea_mcp_challenges_source_token_fkey';
            columns: ['source_api_token_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'user_api_tokens';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      problem_initial_idea_revisions: {
        Row: {
          channel_source: string;
          created_at: string;
          id: string;
          idea: string | null;
          idea_origin: string;
          problem_id: string;
          revision: number;
          revision_kind: string;
          user_id: string;
        };
        Insert: {
          channel_source: string;
          created_at?: string;
          id?: string;
          idea?: string | null;
          idea_origin: string;
          problem_id: string;
          revision: number;
          revision_kind: string;
          user_id: string;
        };
        Update: {
          channel_source?: string;
          created_at?: string;
          id?: string;
          idea?: string | null;
          idea_origin?: string;
          problem_id?: string;
          revision?: number;
          revision_kind?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_initial_idea_revisions_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      problem_mark_annotation_runs: {
        Row: {
          assignments: Json;
          completed_at: string | null;
          copied_from_problem_id: string | null;
          copied_from_run_id: string | null;
          embedding_profile_id: string | null;
          id: string;
          last_error_code: string | null;
          marking_model: string | null;
          marking_prompt_version: string | null;
          objective_snapshot_hash: string | null;
          problem_id: string;
          query_hash: string | null;
          query_template_version: string | null;
          registry_revision_id: number | null;
          retrieval_debug: Json;
          retriever_version: string | null;
          semantic_revision: number;
          skill_candidate_keys: Json;
          skill_resolution: string | null;
          started_at: string;
          status: string;
          unresolved: Json;
        };
        Insert: {
          assignments?: Json;
          completed_at?: string | null;
          copied_from_problem_id?: string | null;
          copied_from_run_id?: string | null;
          embedding_profile_id?: string | null;
          id?: string;
          last_error_code?: string | null;
          marking_model?: string | null;
          marking_prompt_version?: string | null;
          objective_snapshot_hash?: string | null;
          problem_id: string;
          query_hash?: string | null;
          query_template_version?: string | null;
          registry_revision_id?: number | null;
          retrieval_debug?: Json;
          retriever_version?: string | null;
          semantic_revision: number;
          skill_candidate_keys?: Json;
          skill_resolution?: string | null;
          started_at?: string;
          status?: string;
          unresolved?: Json;
        };
        Update: {
          assignments?: Json;
          completed_at?: string | null;
          copied_from_problem_id?: string | null;
          copied_from_run_id?: string | null;
          embedding_profile_id?: string | null;
          id?: string;
          last_error_code?: string | null;
          marking_model?: string | null;
          marking_prompt_version?: string | null;
          objective_snapshot_hash?: string | null;
          problem_id?: string;
          query_hash?: string | null;
          query_template_version?: string | null;
          registry_revision_id?: number | null;
          retrieval_debug?: Json;
          retriever_version?: string | null;
          semantic_revision?: number;
          skill_candidate_keys?: Json;
          skill_resolution?: string | null;
          started_at?: string;
          status?: string;
          unresolved?: Json;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_mark_annotation_runs_copied_from_problem_id_fkey';
            columns: ['copied_from_problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_mark_annotation_runs_copied_from_run_id_fkey';
            columns: ['copied_from_run_id'];
            isOneToOne: false;
            referencedRelation: 'problem_mark_annotation_runs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_mark_annotation_runs_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_mark_annotation_runs_registry_revision_id_fkey';
            columns: ['registry_revision_id'];
            isOneToOne: false;
            referencedRelation: 'knowledge_registry_revisions';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_mark_annotations: {
        Row: {
          active_run_id: string | null;
          attempt_count: number;
          completed_at: string | null;
          created_at: string;
          last_error_code: string | null;
          lease_token: string | null;
          lease_until: string | null;
          next_retry_at: string;
          problem_id: string;
          registry_revision_id: number | null;
          semantic_revision: number;
          status: string;
          unresolved: Json;
          updated_at: string;
        };
        Insert: {
          active_run_id?: string | null;
          attempt_count?: number;
          completed_at?: string | null;
          created_at?: string;
          last_error_code?: string | null;
          lease_token?: string | null;
          lease_until?: string | null;
          next_retry_at?: string;
          problem_id: string;
          registry_revision_id?: number | null;
          semantic_revision: number;
          status?: string;
          unresolved?: Json;
          updated_at?: string;
        };
        Update: {
          active_run_id?: string | null;
          attempt_count?: number;
          completed_at?: string | null;
          created_at?: string;
          last_error_code?: string | null;
          lease_token?: string | null;
          lease_until?: string | null;
          next_retry_at?: string;
          problem_id?: string;
          registry_revision_id?: number | null;
          semantic_revision?: number;
          status?: string;
          unresolved?: Json;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_mark_annotations_active_run_id_fkey';
            columns: ['active_run_id'];
            isOneToOne: false;
            referencedRelation: 'problem_mark_annotation_runs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_mark_annotations_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: true;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_mark_annotations_registry_revision_id_fkey';
            columns: ['registry_revision_id'];
            isOneToOne: false;
            referencedRelation: 'knowledge_registry_revisions';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_marks: {
        Row: {
          created_at: string;
          mark_key: string;
          part_index: number | null;
          problem_id: string;
          registry_revision_id: number | null;
          role: string;
          semantic_revision: number | null;
          source: string | null;
        };
        Insert: {
          created_at?: string;
          mark_key: string;
          part_index?: number | null;
          problem_id: string;
          registry_revision_id?: number | null;
          role: string;
          semantic_revision?: number | null;
          source?: string | null;
        };
        Update: {
          created_at?: string;
          mark_key?: string;
          part_index?: number | null;
          problem_id?: string;
          registry_revision_id?: number | null;
          role?: string;
          semantic_revision?: number | null;
          source?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_marks_mark_key_fkey';
            columns: ['mark_key'];
            isOneToOne: false;
            referencedRelation: 'knowledge_marks';
            referencedColumns: ['stable_key'];
          },
          {
            foreignKeyName: 'problem_marks_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_marks_registry_revision_id_fkey';
            columns: ['registry_revision_id'];
            isOneToOne: false;
            referencedRelation: 'knowledge_registry_revisions';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_review_events: {
        Row: {
          attempt_id: string | null;
          channel_source: string;
          created_at: string;
          device_id: string | null;
          effective_review_at: string;
          event_kind: string;
          human_rating: string | null;
          id: string;
          initial_idea_revision_id: string | null;
          machine_correctness_snapshot: boolean | null;
          problem_id: string;
          received_at: string;
          review_occurrence_id: string;
          reviewed_at: string;
          source_request_id: string;
          supersedes_event_id: string | null;
          user_id: string;
        };
        Insert: {
          attempt_id?: string | null;
          channel_source: string;
          created_at?: string;
          device_id?: string | null;
          effective_review_at: string;
          event_kind: string;
          human_rating?: string | null;
          id?: string;
          initial_idea_revision_id?: string | null;
          machine_correctness_snapshot?: boolean | null;
          problem_id: string;
          received_at?: string;
          review_occurrence_id: string;
          reviewed_at: string;
          source_request_id: string;
          supersedes_event_id?: string | null;
          user_id: string;
        };
        Update: {
          attempt_id?: string | null;
          channel_source?: string;
          created_at?: string;
          device_id?: string | null;
          effective_review_at?: string;
          event_kind?: string;
          human_rating?: string | null;
          id?: string;
          initial_idea_revision_id?: string | null;
          machine_correctness_snapshot?: boolean | null;
          problem_id?: string;
          received_at?: string;
          review_occurrence_id?: string;
          reviewed_at?: string;
          source_request_id?: string;
          supersedes_event_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_events_attempt_owner_fkey';
            columns: ['attempt_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'attempts';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_review_events_initial_idea_fkey';
            columns: ['initial_idea_revision_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'problem_initial_idea_revisions';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_review_events_occurrence_fkey';
            columns: ['review_occurrence_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'problem_review_occurrences';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_review_events_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'problem_review_events_supersedes_fkey';
            columns: [
              'supersedes_event_id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
            isOneToOne: false;
            referencedRelation: 'effective_problem_review_events';
            referencedColumns: [
              'id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
          },
          {
            foreignKeyName: 'problem_review_events_supersedes_fkey';
            columns: [
              'supersedes_event_id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
            isOneToOne: false;
            referencedRelation: 'problem_review_events';
            referencedColumns: [
              'id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
          },
        ];
      };
      problem_review_idea_revisions: {
        Row: {
          asr_model: string | null;
          asr_provider: string | null;
          asr_request_id: string | null;
          channel_source: string;
          created_at: string;
          id: string;
          idea: string | null;
          idea_origin: string;
          problem_id: string;
          review_occurrence_id: string;
          revision: number;
          revision_kind: string;
          user_id: string;
        };
        Insert: {
          asr_model?: string | null;
          asr_provider?: string | null;
          asr_request_id?: string | null;
          channel_source: string;
          created_at?: string;
          id?: string;
          idea?: string | null;
          idea_origin: string;
          problem_id: string;
          review_occurrence_id: string;
          revision: number;
          revision_kind: string;
          user_id: string;
        };
        Update: {
          asr_model?: string | null;
          asr_provider?: string | null;
          asr_request_id?: string | null;
          channel_source?: string;
          created_at?: string;
          id?: string;
          idea?: string | null;
          idea_origin?: string;
          problem_id?: string;
          review_occurrence_id?: string;
          revision?: number;
          revision_kind?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_idea_revisions_occurrence_fkey';
            columns: ['review_occurrence_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'problem_review_occurrences';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
        ];
      };
      problem_review_observations: {
        Row: {
          action: string;
          created_at: string;
          device_id: string | null;
          id: string;
          occurred_at: string;
          problem_id: string;
          request_id: string;
          result: Json;
          user_id: string;
        };
        Insert: {
          action: string;
          created_at?: string;
          device_id?: string | null;
          id?: string;
          occurred_at: string;
          problem_id: string;
          request_id: string;
          result: Json;
          user_id: string;
        };
        Update: {
          action?: string;
          created_at?: string;
          device_id?: string | null;
          id?: string;
          occurred_at?: string;
          problem_id?: string;
          request_id?: string;
          result?: Json;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_observations_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_review_occurrence_parameter_assignments: {
        Row: {
          assigned_at: string;
          assignment_source: string;
          parameter_set_id: string;
          problem_id: string;
          review_occurrence_id: string;
          user_id: string;
        };
        Insert: {
          assigned_at?: string;
          assignment_source: string;
          parameter_set_id: string;
          problem_id: string;
          review_occurrence_id: string;
          user_id: string;
        };
        Update: {
          assigned_at?: string;
          assignment_source?: string;
          parameter_set_id?: string;
          problem_id?: string;
          review_occurrence_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_occurrence_parameter_assig_parameter_set_id_fkey';
            columns: ['parameter_set_id'];
            isOneToOne: false;
            referencedRelation: 'fsrs_parameter_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_review_occurrence_parameter_assignments_occurrence_fkey';
            columns: ['review_occurrence_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'problem_review_occurrences';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
        ];
      };
      problem_review_occurrences: {
        Row: {
          attempt_id: string | null;
          created_at: string;
          effective_review_at: string;
          id: string;
          problem_id: string;
          reviewed_at: string;
          user_id: string;
        };
        Insert: {
          attempt_id?: string | null;
          created_at?: string;
          effective_review_at: string;
          id: string;
          problem_id: string;
          reviewed_at: string;
          user_id: string;
        };
        Update: {
          attempt_id?: string | null;
          created_at?: string;
          effective_review_at?: string;
          id?: string;
          problem_id?: string;
          reviewed_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_occurrences_attempt_owner_fkey';
            columns: ['attempt_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'attempts';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_review_occurrences_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      problem_review_projection_jobs: {
        Row: {
          attempt_count: number;
          dirty_from: string;
          last_error_code: string | null;
          lease_token: string | null;
          lease_until: string | null;
          next_retry_at: string;
          problem_id: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          attempt_count?: number;
          dirty_from: string;
          last_error_code?: string | null;
          lease_token?: string | null;
          lease_until?: string | null;
          next_retry_at?: string;
          problem_id: string;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          attempt_count?: number;
          dirty_from?: string;
          last_error_code?: string | null;
          lease_token?: string | null;
          lease_until?: string | null;
          next_retry_at?: string;
          problem_id?: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_projection_jobs_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      problem_review_projection_runs: {
        Row: {
          base_projection_revision: number;
          completed_at: string | null;
          error_code: string | null;
          id: string;
          lease_token: string;
          problem_id: string;
          reason: string;
          started_at: string;
          status: string;
          timeline_event_count: number;
          timeline_fingerprint: string;
          user_id: string;
        };
        Insert: {
          base_projection_revision: number;
          completed_at?: string | null;
          error_code?: string | null;
          id?: string;
          lease_token: string;
          problem_id: string;
          reason?: string;
          started_at?: string;
          status?: string;
          timeline_event_count: number;
          timeline_fingerprint: string;
          user_id: string;
        };
        Update: {
          base_projection_revision?: number;
          completed_at?: string | null;
          error_code?: string | null;
          id?: string;
          lease_token?: string;
          problem_id?: string;
          reason?: string;
          started_at?: string;
          status?: string;
          timeline_event_count?: number;
          timeline_fingerprint?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_projection_runs_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      problem_review_schedule_applications: {
        Row: {
          algorithm_version: string;
          applied_at: string;
          card_after: Json;
          card_before: Json;
          event_id: string;
          id: string;
          library_name: string;
          library_version: string;
          parameter_set_id: string;
          problem_id: string;
          projection_revision: number;
          projection_run_id: string;
          review_log: Json;
          review_occurrence_id: string;
          sequence: number;
          user_id: string;
        };
        Insert: {
          algorithm_version: string;
          applied_at?: string;
          card_after: Json;
          card_before: Json;
          event_id: string;
          id?: string;
          library_name: string;
          library_version: string;
          parameter_set_id: string;
          problem_id: string;
          projection_revision: number;
          projection_run_id: string;
          review_log: Json;
          review_occurrence_id: string;
          sequence: number;
          user_id: string;
        };
        Update: {
          algorithm_version?: string;
          applied_at?: string;
          card_after?: Json;
          card_before?: Json;
          event_id?: string;
          id?: string;
          library_name?: string;
          library_version?: string;
          parameter_set_id?: string;
          problem_id?: string;
          projection_revision?: number;
          projection_run_id?: string;
          review_log?: Json;
          review_occurrence_id?: string;
          sequence?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_schedule_applications_event_fkey';
            columns: [
              'event_id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
            isOneToOne: false;
            referencedRelation: 'effective_problem_review_events';
            referencedColumns: [
              'id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
          },
          {
            foreignKeyName: 'problem_review_schedule_applications_event_fkey';
            columns: [
              'event_id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
            isOneToOne: false;
            referencedRelation: 'problem_review_events';
            referencedColumns: [
              'id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
          },
          {
            foreignKeyName: 'problem_review_schedule_applications_parameter_set_id_fkey';
            columns: ['parameter_set_id'];
            isOneToOne: false;
            referencedRelation: 'fsrs_parameter_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_review_schedule_applications_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'problem_review_schedule_applications_projection_run_id_fkey';
            columns: ['projection_run_id'];
            isOneToOne: false;
            referencedRelation: 'problem_review_projection_runs';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_review_sm2_compatibility_baselines: {
        Row: {
          anchor_review_occurrence_id: string;
          captured_at: string;
          created_at: string;
          ease_factor: number;
          interval_days: number;
          last_reviewed_at: string | null;
          next_review_at: string | null;
          problem_id: string;
          repetition_number: number;
          schedule_existed: boolean;
          timezone: string;
          user_id: string;
        };
        Insert: {
          anchor_review_occurrence_id: string;
          captured_at: string;
          created_at?: string;
          ease_factor: number;
          interval_days: number;
          last_reviewed_at?: string | null;
          next_review_at?: string | null;
          problem_id: string;
          repetition_number: number;
          schedule_existed: boolean;
          timezone: string;
          user_id: string;
        };
        Update: {
          anchor_review_occurrence_id?: string;
          captured_at?: string;
          created_at?: string;
          ease_factor?: number;
          interval_days?: number;
          last_reviewed_at?: string | null;
          next_review_at?: string | null;
          problem_id?: string;
          repetition_number?: number;
          schedule_existed?: boolean;
          timezone?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_sm2_baselines_anchor_fkey';
            columns: ['anchor_review_occurrence_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'problem_review_occurrences';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_review_sm2_baselines_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      problem_set_copies: {
        Row: {
          created_at: string;
          problem_set_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          problem_set_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          problem_set_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_set_copies_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_copies_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_set_favourites: {
        Row: {
          created_at: string;
          problem_set_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          problem_set_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          problem_set_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_set_favourites_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_favourites_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_set_likes: {
        Row: {
          created_at: string;
          problem_set_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          problem_set_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          problem_set_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_set_likes_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_likes_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_set_problems: {
        Row: {
          added_at: string | null;
          id: string;
          problem_id: string;
          problem_set_id: string;
          user_id: string;
        };
        Insert: {
          added_at?: string | null;
          id?: string;
          problem_id: string;
          problem_set_id: string;
          user_id: string;
        };
        Update: {
          added_at?: string | null;
          id?: string;
          problem_id?: string;
          problem_set_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_set_problems_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_problems_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_problems_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_set_reports: {
        Row: {
          created_at: string;
          details: string | null;
          id: string;
          problem_set_id: string;
          reason: string;
          reporter_user_id: string;
          status: string;
        };
        Insert: {
          created_at?: string;
          details?: string | null;
          id?: string;
          problem_set_id: string;
          reason: string;
          reporter_user_id: string;
          status?: string;
        };
        Update: {
          created_at?: string;
          details?: string | null;
          id?: string;
          problem_set_id?: string;
          reason?: string;
          reporter_user_id?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_set_reports_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_reports_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_set_shares: {
        Row: {
          created_at: string | null;
          id: string;
          problem_set_id: string;
          shared_by_user_id: string;
          shared_with_email: string;
        };
        Insert: {
          created_at?: string | null;
          id?: string;
          problem_set_id: string;
          shared_by_user_id: string;
          shared_with_email: string;
        };
        Update: {
          created_at?: string | null;
          id?: string;
          problem_set_id?: string;
          shared_by_user_id?: string;
          shared_with_email?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_set_shares_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_shares_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_set_stats: {
        Row: {
          copy_count: number;
          like_count: number;
          problem_count: number;
          problem_set_id: string;
          ranking_score: number;
          unique_view_count: number;
          updated_at: string;
          view_count: number;
        };
        Insert: {
          copy_count?: number;
          like_count?: number;
          problem_count?: number;
          problem_set_id: string;
          ranking_score?: number;
          unique_view_count?: number;
          updated_at?: string;
          view_count?: number;
        };
        Update: {
          copy_count?: number;
          like_count?: number;
          problem_count?: number;
          problem_set_id?: string;
          ranking_score?: number;
          unique_view_count?: number;
          updated_at?: string;
          view_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_set_stats_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: true;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_stats_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: true;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_set_views: {
        Row: {
          created_at: string;
          id: string;
          problem_set_id: string;
          time_bucket: string;
          user_id: string | null;
          viewer_hash: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          problem_set_id: string;
          time_bucket: string;
          user_id?: string | null;
          viewer_hash: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          problem_set_id?: string;
          time_bucket?: string;
          user_id?: string | null;
          viewer_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_set_views_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_set_views_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_sets: {
        Row: {
          allow_copying: boolean;
          created_at: string | null;
          description: string | null;
          discovery_subject: string | null;
          filter_config: Json | null;
          fts: unknown;
          id: string;
          is_listed: boolean;
          is_smart: boolean;
          name: string;
          session_config: Json | null;
          sharing_level: Database['public']['Enums']['sharing_level'];
          subject_id: string;
          type: string;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          allow_copying?: boolean;
          created_at?: string | null;
          description?: string | null;
          discovery_subject?: string | null;
          filter_config?: Json | null;
          fts?: unknown;
          id?: string;
          is_listed?: boolean;
          is_smart?: boolean;
          name: string;
          session_config?: Json | null;
          sharing_level?: Database['public']['Enums']['sharing_level'];
          subject_id: string;
          type?: string;
          updated_at?: string | null;
          user_id: string;
        };
        Update: {
          allow_copying?: boolean;
          created_at?: string | null;
          description?: string | null;
          discovery_subject?: string | null;
          filter_config?: Json | null;
          fts?: unknown;
          id?: string;
          is_listed?: boolean;
          is_smart?: boolean;
          name?: string;
          session_config?: Json | null;
          sharing_level?: Database['public']['Enums']['sharing_level'];
          subject_id?: string;
          type?: string;
          updated_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_sets_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_status_history: {
        Row: {
          changed_at: string;
          changed_date: string;
          id: string;
          new_status: string;
          old_status: string | null;
          problem_id: string;
          user_id: string;
        };
        Insert: {
          changed_at?: string;
          changed_date?: string;
          id?: string;
          new_status: string;
          old_status?: string | null;
          problem_id: string;
          user_id: string;
        };
        Update: {
          changed_at?: string;
          changed_date?: string;
          id?: string;
          new_status?: string;
          old_status?: string | null;
          problem_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_status_history_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_tag: {
        Row: {
          created_at: string;
          problem_id: string;
          tag_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          problem_id: string;
          tag_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          problem_id?: string;
          tag_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_tag_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'problem_tag_tag_id_fkey';
            columns: ['tag_id'];
            isOneToOne: false;
            referencedRelation: 'tags';
            referencedColumns: ['id'];
          },
        ];
      };
      problem_user_contexts: {
        Row: {
          created_at: string;
          current_initial_idea_revision_id: string | null;
          problem_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          current_initial_idea_revision_id?: string | null;
          problem_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          current_initial_idea_revision_id?: string | null;
          problem_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_user_contexts_current_revision_fkey';
            columns: [
              'current_initial_idea_revision_id',
              'user_id',
              'problem_id',
            ];
            isOneToOne: false;
            referencedRelation: 'problem_initial_idea_revisions';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_user_contexts_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
        ];
      };
      problems: {
        Row: {
          assets: Json;
          content: string | null;
          created_at: string;
          embedding: string | null;
          id: string;
          is_optional: boolean;
          last_reviewed_date: string | null;
          parts: Json;
          revision: number;
          semantic_revision: number;
          solution_assets: Json;
          solution_text: string | null;
          source: Json;
          status: Database['public']['Enums']['problem_status_enum'];
          subject_id: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          assets?: Json;
          content?: string | null;
          created_at?: string;
          embedding?: string | null;
          id?: string;
          is_optional?: boolean;
          last_reviewed_date?: string | null;
          parts: Json;
          revision?: number;
          semantic_revision?: number;
          solution_assets?: Json;
          solution_text?: string | null;
          source?: Json;
          status: Database['public']['Enums']['problem_status_enum'];
          subject_id: string;
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          assets?: Json;
          content?: string | null;
          created_at?: string;
          embedding?: string | null;
          id?: string;
          is_optional?: boolean;
          last_reviewed_date?: string | null;
          parts?: Json;
          revision?: number;
          semantic_revision?: number;
          solution_assets?: Json;
          solution_text?: string | null;
          source?: Json;
          status?: Database['public']['Enums']['problem_status_enum'];
          subject_id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'problems_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
        ];
      };
      qr_upload_sessions: {
        Row: {
          consumed_at: string | null;
          created_at: string;
          expires_at: string;
          file_path: string | null;
          id: string;
          mime_type: string | null;
          status: string;
          token_hash: string;
          uploaded_at: string | null;
          user_id: string;
        };
        Insert: {
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          file_path?: string | null;
          id?: string;
          mime_type?: string | null;
          status?: string;
          token_hash: string;
          uploaded_at?: string | null;
          user_id: string;
        };
        Update: {
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          file_path?: string | null;
          id?: string;
          mime_type?: string | null;
          status?: string;
          token_hash?: string;
          uploaded_at?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      review_schedule: {
        Row: {
          authority_algorithm: string;
          authority_parameter_set_id: string | null;
          authority_projection_revision: number | null;
          created_at: string;
          ease_factor: number;
          id: string;
          interval_days: number;
          last_reviewed_at: string | null;
          next_review_at: string;
          problem_id: string;
          repetition_number: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          authority_algorithm?: string;
          authority_parameter_set_id?: string | null;
          authority_projection_revision?: number | null;
          created_at?: string;
          ease_factor?: number;
          id?: string;
          interval_days?: number;
          last_reviewed_at?: string | null;
          next_review_at: string;
          problem_id: string;
          repetition_number?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          authority_algorithm?: string;
          authority_parameter_set_id?: string | null;
          authority_projection_revision?: number | null;
          created_at?: string;
          ease_factor?: number;
          id?: string;
          interval_days?: number;
          last_reviewed_at?: string | null;
          next_review_at?: string;
          problem_id?: string;
          repetition_number?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_schedule_authority_parameter_set_id_fkey';
            columns: ['authority_parameter_set_id'];
            isOneToOne: false;
            referencedRelation: 'fsrs_parameter_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_schedule_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
        ];
      };
      review_session_results: {
        Row: {
          completed_at: string;
          id: string;
          problem_id: string;
          session_state_id: string;
          was_correct: boolean | null;
          was_skipped: boolean;
        };
        Insert: {
          completed_at?: string;
          id?: string;
          problem_id: string;
          session_state_id: string;
          was_correct?: boolean | null;
          was_skipped?: boolean;
        };
        Update: {
          completed_at?: string;
          id?: string;
          problem_id?: string;
          session_state_id?: string;
          was_correct?: boolean | null;
          was_skipped?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'review_session_results_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_session_results_session_state_id_fkey';
            columns: ['session_state_id'];
            isOneToOne: false;
            referencedRelation: 'review_session_state';
            referencedColumns: ['id'];
          },
        ];
      };
      review_session_state: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          last_activity_at: string;
          problem_set_id: string | null;
          session_state: Json;
          session_type: string;
          started_at: string;
          subject_id: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          last_activity_at?: string;
          problem_set_id?: string | null;
          session_state?: Json;
          session_type?: string;
          started_at?: string;
          subject_id?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          last_activity_at?: string;
          problem_set_id?: string | null;
          session_state?: Json;
          session_type?: string;
          started_at?: string;
          subject_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_session_state_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_session_state_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'review_session_state_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
        ];
      };
      study_observations: {
        Row: {
          action: string;
          created_at: string;
          device_id: string | null;
          id: string;
          item_id: string;
          mode: string;
          occurred_at: string;
          request_id: string;
          result: Json;
          sequence: number;
          session_id: string;
          user_id: string;
        };
        Insert: {
          action: string;
          created_at?: string;
          device_id?: string | null;
          id?: string;
          item_id: string;
          mode: string;
          occurred_at: string;
          request_id: string;
          result: Json;
          sequence: number;
          session_id: string;
          user_id: string;
        };
        Update: {
          action?: string;
          created_at?: string;
          device_id?: string | null;
          id?: string;
          item_id?: string;
          mode?: string;
          occurred_at?: string;
          request_id?: string;
          result?: Json;
          sequence?: number;
          session_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'study_observations_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'esp32_devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'study_observations_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'study_sessions';
            referencedColumns: ['id'];
          },
        ];
      };
      study_sessions: {
        Row: {
          candidate_count: number;
          candidate_items: Json;
          create_fingerprint: string;
          create_request_id: string;
          created_at: string;
          cursor: string | null;
          device_id: string | null;
          domain: string;
          ended_at: string | null;
          expires_at: string;
          has_more: boolean;
          id: string;
          last_activity_at: string;
          mode: string;
          next_sequence: number;
          optional_count: number | null;
          ordering: string;
          progress_revision: number;
          purpose: string;
          scope: Json;
          seed: string;
          snapshot: Json;
          started_at: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          candidate_count?: number;
          candidate_items?: Json;
          create_fingerprint: string;
          create_request_id: string;
          created_at?: string;
          cursor?: string | null;
          device_id?: string | null;
          domain: string;
          ended_at?: string | null;
          expires_at?: string;
          has_more?: boolean;
          id?: string;
          last_activity_at?: string;
          mode: string;
          next_sequence?: number;
          optional_count?: number | null;
          ordering: string;
          progress_revision?: number;
          purpose: string;
          scope: Json;
          seed: string;
          snapshot?: Json;
          started_at?: string;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          candidate_count?: number;
          candidate_items?: Json;
          create_fingerprint?: string;
          create_request_id?: string;
          created_at?: string;
          cursor?: string | null;
          device_id?: string | null;
          domain?: string;
          ended_at?: string | null;
          expires_at?: string;
          has_more?: boolean;
          id?: string;
          last_activity_at?: string;
          mode?: string;
          next_sequence?: number;
          optional_count?: number | null;
          ordering?: string;
          progress_revision?: number;
          purpose?: string;
          scope?: Json;
          seed?: string;
          snapshot?: Json;
          started_at?: string;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'study_sessions_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'esp32_devices';
            referencedColumns: ['id'];
          },
        ];
      };
      subjects: {
        Row: {
          canonical_subject_key: string | null;
          color: string | null;
          created_at: string;
          icon: string | null;
          id: string;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          canonical_subject_key?: string | null;
          color?: string | null;
          created_at?: string;
          icon?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          canonical_subject_key?: string | null;
          color?: string | null;
          created_at?: string;
          icon?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'subjects_canonical_subject_key_fkey';
            columns: ['canonical_subject_key'];
            isOneToOne: false;
            referencedRelation: 'canonical_subjects';
            referencedColumns: ['stable_key'];
          },
        ];
      };
      tags: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          subject_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          subject_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          subject_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tags_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
        ];
      };
      todos: {
        Row: {
          archived_at: string | null;
          cancelled_at: string | null;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          description: string | null;
          due_at: string | null;
          id: string;
          metadata: Json;
          note_id: string | null;
          notebook_id: string | null;
          priority: string;
          problem_id: string | null;
          problem_set_id: string | null;
          reminder_at: string | null;
          revision: number;
          source: string;
          source_conversation_id: string | null;
          source_device_id: string | null;
          status: string;
          subject_id: string | null;
          title: string;
          updated_at: string;
          user_id: string;
          word_deck_id: string | null;
          word_entry_id: string | null;
        };
        Insert: {
          archived_at?: string | null;
          cancelled_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          due_at?: string | null;
          id?: string;
          metadata?: Json;
          note_id?: string | null;
          notebook_id?: string | null;
          priority?: string;
          problem_id?: string | null;
          problem_set_id?: string | null;
          reminder_at?: string | null;
          revision?: number;
          source?: string;
          source_conversation_id?: string | null;
          source_device_id?: string | null;
          status?: string;
          subject_id?: string | null;
          title: string;
          updated_at?: string;
          user_id: string;
          word_deck_id?: string | null;
          word_entry_id?: string | null;
        };
        Update: {
          archived_at?: string | null;
          cancelled_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          due_at?: string | null;
          id?: string;
          metadata?: Json;
          note_id?: string | null;
          notebook_id?: string | null;
          priority?: string;
          problem_id?: string | null;
          problem_set_id?: string | null;
          reminder_at?: string | null;
          revision?: number;
          source?: string;
          source_conversation_id?: string | null;
          source_device_id?: string | null;
          status?: string;
          subject_id?: string | null;
          title?: string;
          updated_at?: string;
          user_id?: string;
          word_deck_id?: string | null;
          word_entry_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'todos_note_id_fkey';
            columns: ['note_id'];
            isOneToOne: false;
            referencedRelation: 'notebook_notes';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'todos_notebook_id_fkey';
            columns: ['notebook_id'];
            isOneToOne: false;
            referencedRelation: 'notebooks';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'todos_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'todos_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'todos_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'todos_source_device_id_fkey';
            columns: ['source_device_id'];
            isOneToOne: false;
            referencedRelation: 'esp32_devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'todos_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'todos_word_deck_id_fkey';
            columns: ['word_deck_id'];
            isOneToOne: false;
            referencedRelation: 'word_decks';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'todos_word_entry_id_fkey';
            columns: ['word_entry_id'];
            isOneToOne: false;
            referencedRelation: 'word_entries';
            referencedColumns: ['id'];
          },
        ];
      };
      usage_quotas: {
        Row: {
          created_at: string;
          id: string;
          period_start: string;
          resource_type: string;
          updated_at: string;
          usage_count: number;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          period_start?: string;
          resource_type: string;
          updated_at?: string;
          usage_count?: number;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          period_start?: string;
          resource_type?: string;
          updated_at?: string;
          usage_count?: number;
          user_id?: string;
        };
        Relationships: [];
      };
      user_activity_log: {
        Row: {
          action: string;
          created_at: string | null;
          details: Json | null;
          id: string;
          ip_address: unknown;
          resource_id: string | null;
          resource_type: string | null;
          user_agent: string | null;
          user_id: string | null;
        };
        Insert: {
          action: string;
          created_at?: string | null;
          details?: Json | null;
          id?: string;
          ip_address?: unknown;
          resource_id?: string | null;
          resource_type?: string | null;
          user_agent?: string | null;
          user_id?: string | null;
        };
        Update: {
          action?: string;
          created_at?: string | null;
          details?: Json | null;
          id?: string;
          ip_address?: unknown;
          resource_id?: string | null;
          resource_type?: string | null;
          user_agent?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      user_api_tokens: {
        Row: {
          created_at: string;
          id: string;
          last_used_at: string | null;
          name: string;
          revoked_at: string | null;
          token_hash: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          name: string;
          revoked_at?: string | null;
          token_hash: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          last_used_at?: string | null;
          name?: string;
          revoked_at?: string | null;
          token_hash?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_fsrs_parameter_activations: {
        Row: {
          activated_at: string;
          activation_source: string;
          id: number;
          parameter_set_id: string;
          user_id: string;
        };
        Insert: {
          activated_at?: string;
          activation_source: string;
          id?: never;
          parameter_set_id: string;
          user_id: string;
        };
        Update: {
          activated_at?: string;
          activation_source?: string;
          id?: never;
          parameter_set_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_fsrs_parameter_activations_parameter_set_id_fkey';
            columns: ['parameter_set_id'];
            isOneToOne: false;
            referencedRelation: 'fsrs_parameter_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      user_fsrs_settings: {
        Row: {
          active_cutover_id: string | null;
          active_parameter_set_id: string;
          authority_mode: string;
          created_at: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          active_cutover_id?: string | null;
          active_parameter_set_id: string;
          authority_mode?: string;
          created_at?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          active_cutover_id?: string | null;
          active_parameter_set_id?: string;
          authority_mode?: string;
          created_at?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'user_fsrs_settings_active_cutover_fkey';
            columns: ['active_cutover_id'];
            isOneToOne: false;
            referencedRelation: 'fsrs_authority_cutovers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_fsrs_settings_active_parameter_set_id_fkey';
            columns: ['active_parameter_set_id'];
            isOneToOne: false;
            referencedRelation: 'fsrs_parameter_sets';
            referencedColumns: ['id'];
          },
        ];
      };
      user_profiles: {
        Row: {
          avatar_url: string | null;
          bio: string | null;
          created_at: string | null;
          date_of_birth: string | null;
          first_name: string | null;
          gender: string | null;
          id: string;
          is_active: boolean | null;
          last_login_at: string | null;
          last_name: string | null;
          onboarding_completed_at: string | null;
          region: string | null;
          timezone: string | null;
          updated_at: string | null;
          user_role: string | null;
          username: string;
        };
        Insert: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string | null;
          date_of_birth?: string | null;
          first_name?: string | null;
          gender?: string | null;
          id: string;
          is_active?: boolean | null;
          last_login_at?: string | null;
          last_name?: string | null;
          onboarding_completed_at?: string | null;
          region?: string | null;
          timezone?: string | null;
          updated_at?: string | null;
          user_role?: string | null;
          username: string;
        };
        Update: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string | null;
          date_of_birth?: string | null;
          first_name?: string | null;
          gender?: string | null;
          id?: string;
          is_active?: boolean | null;
          last_login_at?: string | null;
          last_name?: string | null;
          onboarding_completed_at?: string | null;
          region?: string | null;
          timezone?: string | null;
          updated_at?: string | null;
          user_role?: string | null;
          username?: string;
        };
        Relationships: [];
      };
      user_quota_overrides: {
        Row: {
          created_at: string;
          daily_limit: number;
          id: string;
          resource_type: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          daily_limit: number;
          id?: string;
          resource_type: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          daily_limit?: number;
          id?: string;
          resource_type?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      word_change_log: {
        Row: {
          created_at: string;
          deck_id: string;
          entity_id: string;
          entity_kind: string;
          operation: string;
          payload: Json;
          sequence: number;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          deck_id: string;
          entity_id: string;
          entity_kind: string;
          operation: string;
          payload?: Json;
          sequence?: never;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          deck_id?: string;
          entity_id?: string;
          entity_kind?: string;
          operation?: string;
          payload?: Json;
          sequence?: never;
          user_id?: string | null;
        };
        Relationships: [];
      };
      word_deck_ai_access: {
        Row: {
          can_create: boolean;
          can_read: boolean;
          can_update: boolean;
          created_at: string;
          deck_id: string;
          id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          can_create?: boolean;
          can_read?: boolean;
          can_update?: boolean;
          created_at?: string;
          deck_id: string;
          id?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          can_create?: boolean;
          can_read?: boolean;
          can_update?: boolean;
          created_at?: string;
          deck_id?: string;
          id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'word_deck_ai_access_deck_id_fkey';
            columns: ['deck_id'];
            isOneToOne: false;
            referencedRelation: 'word_decks';
            referencedColumns: ['id'];
          },
        ];
      };
      word_decks: {
        Row: {
          archived_at: string | null;
          created_at: string;
          description: string | null;
          id: string;
          is_active: boolean;
          is_system: boolean;
          language: string;
          lexicon_type: string;
          metadata: Json;
          revision: number;
          source: string;
          subject_id: string | null;
          target_language: string;
          title: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          is_system?: boolean;
          language?: string;
          lexicon_type?: string;
          metadata?: Json;
          revision?: number;
          source?: string;
          subject_id?: string | null;
          target_language?: string;
          title: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          is_system?: boolean;
          language?: string;
          lexicon_type?: string;
          metadata?: Json;
          revision?: number;
          source?: string;
          subject_id?: string | null;
          target_language?: string;
          title?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'word_decks_subject_id_fkey';
            columns: ['subject_id'];
            isOneToOne: false;
            referencedRelation: 'subjects';
            referencedColumns: ['id'];
          },
        ];
      };
      word_entries: {
        Row: {
          created_at: string;
          deck_id: string;
          example: string | null;
          example_translation: string | null;
          id: string;
          meaning: string;
          metadata: Json;
          normalized_word: string;
          part_of_speech: string | null;
          phonetic: string | null;
          revision: number;
          sort_index: number;
          tags: string[];
          updated_at: string;
          word: string;
        };
        Insert: {
          created_at?: string;
          deck_id: string;
          example?: string | null;
          example_translation?: string | null;
          id?: string;
          meaning: string;
          metadata?: Json;
          normalized_word: string;
          part_of_speech?: string | null;
          phonetic?: string | null;
          revision?: number;
          sort_index?: number;
          tags?: string[];
          updated_at?: string;
          word: string;
        };
        Update: {
          created_at?: string;
          deck_id?: string;
          example?: string | null;
          example_translation?: string | null;
          id?: string;
          meaning?: string;
          metadata?: Json;
          normalized_word?: string;
          part_of_speech?: string | null;
          phonetic?: string | null;
          revision?: number;
          sort_index?: number;
          tags?: string[];
          updated_at?: string;
          word?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'word_entries_deck_id_fkey';
            columns: ['deck_id'];
            isOneToOne: false;
            referencedRelation: 'word_decks';
            referencedColumns: ['id'];
          },
        ];
      };
      word_mistake_links: {
        Row: {
          created_at: string;
          id: string;
          problem_id: string;
          problem_set_id: string;
          updated_at: string;
          user_id: string;
          word_entry_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          problem_id: string;
          problem_set_id: string;
          updated_at?: string;
          user_id: string;
          word_entry_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          problem_id?: string;
          problem_set_id?: string;
          updated_at?: string;
          user_id?: string;
          word_entry_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'word_mistake_links_problem_id_fkey';
            columns: ['problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'word_mistake_links_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'discoverable_problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'word_mistake_links_problem_set_id_fkey';
            columns: ['problem_set_id'];
            isOneToOne: false;
            referencedRelation: 'problem_sets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'word_mistake_links_word_entry_id_fkey';
            columns: ['word_entry_id'];
            isOneToOne: false;
            referencedRelation: 'word_entries';
            referencedColumns: ['id'];
          },
        ];
      };
      word_packs: {
        Row: {
          byte_size: number;
          compression: string;
          created_at: string;
          deck_id: string;
          entry_count: number;
          format: string;
          id: string;
          revision: number;
          schema_version: number;
          sha256: string;
          status: string;
          storage_path: string;
          updated_at: string;
        };
        Insert: {
          byte_size: number;
          compression?: string;
          created_at?: string;
          deck_id: string;
          entry_count: number;
          format?: string;
          id?: string;
          revision: number;
          schema_version?: number;
          sha256: string;
          status?: string;
          storage_path: string;
          updated_at?: string;
        };
        Update: {
          byte_size?: number;
          compression?: string;
          created_at?: string;
          deck_id?: string;
          entry_count?: number;
          format?: string;
          id?: string;
          revision?: number;
          schema_version?: number;
          sha256?: string;
          status?: string;
          storage_path?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'word_packs_deck_id_fkey';
            columns: ['deck_id'];
            isOneToOne: false;
            referencedRelation: 'word_decks';
            referencedColumns: ['id'];
          },
        ];
      };
      word_progress: {
        Row: {
          correct_streak: number;
          created_at: string;
          due_at: string | null;
          id: string;
          interval_days: number;
          known_count: number;
          lapses: number;
          last_reviewed_at: string | null;
          metadata: Json;
          reviewed_count: number;
          status: string;
          unknown_count: number;
          updated_at: string;
          user_id: string;
          word_entry_id: string;
        };
        Insert: {
          correct_streak?: number;
          created_at?: string;
          due_at?: string | null;
          id?: string;
          interval_days?: number;
          known_count?: number;
          lapses?: number;
          last_reviewed_at?: string | null;
          metadata?: Json;
          reviewed_count?: number;
          status?: string;
          unknown_count?: number;
          updated_at?: string;
          user_id: string;
          word_entry_id: string;
        };
        Update: {
          correct_streak?: number;
          created_at?: string;
          due_at?: string | null;
          id?: string;
          interval_days?: number;
          known_count?: number;
          lapses?: number;
          last_reviewed_at?: string | null;
          metadata?: Json;
          reviewed_count?: number;
          status?: string;
          unknown_count?: number;
          updated_at?: string;
          user_id?: string;
          word_entry_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'word_progress_word_entry_id_fkey';
            columns: ['word_entry_id'];
            isOneToOne: false;
            referencedRelation: 'word_entries';
            referencedColumns: ['id'];
          },
        ];
      };
      word_review_events: {
        Row: {
          conversation_id: string | null;
          created_at: string;
          device_id: string | null;
          id: string;
          metadata: Json;
          mode: string;
          outcome: string;
          request_id: string | null;
          sequence: number | null;
          session_id: string | null;
          source: string;
          study_observation_id: string | null;
          user_id: string;
          word_entry_id: string;
          wrong_problem_id: string | null;
        };
        Insert: {
          conversation_id?: string | null;
          created_at?: string;
          device_id?: string | null;
          id?: string;
          metadata?: Json;
          mode: string;
          outcome: string;
          request_id?: string | null;
          sequence?: number | null;
          session_id?: string | null;
          source?: string;
          study_observation_id?: string | null;
          user_id: string;
          word_entry_id: string;
          wrong_problem_id?: string | null;
        };
        Update: {
          conversation_id?: string | null;
          created_at?: string;
          device_id?: string | null;
          id?: string;
          metadata?: Json;
          mode?: string;
          outcome?: string;
          request_id?: string | null;
          sequence?: number | null;
          session_id?: string | null;
          source?: string;
          study_observation_id?: string | null;
          user_id?: string;
          word_entry_id?: string;
          wrong_problem_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'word_review_events_device_id_fkey';
            columns: ['device_id'];
            isOneToOne: false;
            referencedRelation: 'esp32_devices';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'word_review_events_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'study_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'word_review_events_study_observation_id_fkey';
            columns: ['study_observation_id'];
            isOneToOne: false;
            referencedRelation: 'study_observations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'word_review_events_word_entry_id_fkey';
            columns: ['word_entry_id'];
            isOneToOne: false;
            referencedRelation: 'word_entries';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'word_review_events_wrong_problem_id_fkey';
            columns: ['wrong_problem_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      discoverable_problem_sets: {
        Row: {
          copy_count: number | null;
          created_at: string | null;
          description: string | null;
          discovery_subject: string | null;
          fts: unknown;
          id: string | null;
          is_smart: boolean | null;
          like_count: number | null;
          name: string | null;
          problem_count: number | null;
          ranking_score: number | null;
          unique_view_count: number | null;
          user_id: string | null;
          view_count: number | null;
        };
        Relationships: [];
      };
      effective_problem_review_events: {
        Row: {
          attempt_id: string | null;
          channel_source: string | null;
          created_at: string | null;
          device_id: string | null;
          effective_review_at: string | null;
          event_kind: string | null;
          human_rating: string | null;
          id: string | null;
          initial_idea_revision_id: string | null;
          machine_correctness_snapshot: boolean | null;
          problem_id: string | null;
          received_at: string | null;
          review_occurrence_id: string | null;
          reviewed_at: string | null;
          source_request_id: string | null;
          supersedes_event_id: string | null;
          user_id: string | null;
        };
        Insert: {
          attempt_id?: string | null;
          channel_source?: string | null;
          created_at?: string | null;
          device_id?: string | null;
          effective_review_at?: string | null;
          event_kind?: string | null;
          human_rating?: string | null;
          id?: string | null;
          initial_idea_revision_id?: string | null;
          machine_correctness_snapshot?: boolean | null;
          problem_id?: string | null;
          received_at?: string | null;
          review_occurrence_id?: string | null;
          reviewed_at?: string | null;
          source_request_id?: string | null;
          supersedes_event_id?: string | null;
          user_id?: string | null;
        };
        Update: {
          attempt_id?: string | null;
          channel_source?: string | null;
          created_at?: string | null;
          device_id?: string | null;
          effective_review_at?: string | null;
          event_kind?: string | null;
          human_rating?: string | null;
          id?: string | null;
          initial_idea_revision_id?: string | null;
          machine_correctness_snapshot?: boolean | null;
          problem_id?: string | null;
          received_at?: string | null;
          review_occurrence_id?: string | null;
          reviewed_at?: string | null;
          source_request_id?: string | null;
          supersedes_event_id?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'problem_review_events_attempt_owner_fkey';
            columns: ['attempt_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'attempts';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_review_events_initial_idea_fkey';
            columns: ['initial_idea_revision_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'problem_initial_idea_revisions';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_review_events_occurrence_fkey';
            columns: ['review_occurrence_id', 'user_id', 'problem_id'];
            isOneToOne: false;
            referencedRelation: 'problem_review_occurrences';
            referencedColumns: ['id', 'user_id', 'problem_id'];
          },
          {
            foreignKeyName: 'problem_review_events_problem_owner_fkey';
            columns: ['problem_id', 'user_id'];
            isOneToOne: false;
            referencedRelation: 'problems';
            referencedColumns: ['id', 'user_id'];
          },
          {
            foreignKeyName: 'problem_review_events_supersedes_fkey';
            columns: [
              'supersedes_event_id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
            isOneToOne: false;
            referencedRelation: 'effective_problem_review_events';
            referencedColumns: [
              'id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
          },
          {
            foreignKeyName: 'problem_review_events_supersedes_fkey';
            columns: [
              'supersedes_event_id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
            isOneToOne: false;
            referencedRelation: 'problem_review_events';
            referencedColumns: [
              'id',
              'review_occurrence_id',
              'user_id',
              'problem_id',
            ];
          },
        ];
      };
    };
    Functions: {
      activate_user_fsrs_parameter_set: {
        Args: { p_parameter_set_id: string; p_user_id: string };
        Returns: Json;
      };
      apply_problem_mark_annotation: {
        Args: {
          p_assignments: Json;
          p_problem_id: string;
          p_registry_revision_id: number;
          p_semantic_revision: number;
          p_unresolved: Json;
        };
        Returns: Json;
      };
      approve_device_claim_v3: {
        Args: {
          p_access_token_hash: string;
          p_action: string;
          p_claim_id: string;
          p_device_id: string;
          p_device_name: string;
          p_sealed_credential: Json;
          p_user_id: string;
        };
        Returns: {
          device_id: string;
          sealed_credential: Json;
        }[];
      };
      bump_device_content_revision: {
        Args: { p_domain: string; p_scope_key: string };
        Returns: undefined;
      };
      can_view_problem: { Args: { p_problem_id: string }; Returns: boolean };
      cancel_fsrs_authority_cutover: {
        Args: { p_cutover_id: string; p_user_id: string };
        Returns: Json;
      };
      check_and_increment_quota: {
        Args: {
          p_default_limit: number;
          p_resource_type: string;
          p_user_id: string;
          p_user_tz?: string;
        };
        Returns: Json;
      };
      claim_problem_mark_annotation: {
        Args: { p_lease_seconds?: number; p_problem_id: string };
        Returns: Json;
      };
      claim_problem_mark_annotations: {
        Args: { p_lease_seconds?: number; p_limit?: number };
        Returns: Json;
      };
      claim_problem_review_projection_jobs: {
        Args: { p_lease_seconds?: number; p_limit?: number };
        Returns: Json;
      };
      cleanup_device_control_v3: { Args: never; Returns: number };
      commit_device_control_response_v3: {
        Args: {
          p_ack_sync_cursor: number;
          p_boot_id: string;
          p_capabilities: Json;
          p_device_id: string;
          p_endpoint: string;
          p_firmware_version: string;
          p_http_status: number;
          p_last_sync_at: string | null;
          p_request_fingerprint: string;
          p_request_id: string;
          p_response_body: Json;
          p_seen_at: string;
        };
        Returns: undefined;
      };
      commit_problem_mark_annotation_run: {
        Args: {
          p_assignments: Json;
          p_embedding_profile_id: string;
          p_lease_token: string;
          p_marking_model: string;
          p_marking_prompt_version: string;
          p_objective_snapshot_hash: string;
          p_query_hash: string;
          p_query_template_version: string;
          p_retrieval_debug: Json;
          p_retriever_version: string;
          p_run_id: string;
          p_skill_candidate_keys: Json;
          p_skill_resolution: string;
          p_unresolved: Json;
        };
        Returns: Json;
      };
      commit_problem_review_projection: {
        Args: {
          p_applications: Json;
          p_expected_base_revision: number;
          p_expected_event_count: number;
          p_expected_fingerprint: string;
          p_fsrs_card: Json;
          p_lease_token: string;
          p_run_id: string;
          p_sm2_projection: Json;
        };
        Returns: Json;
      };
      compute_problem_set_count: {
        Args: { p_problem_set_id: string };
        Returns: number;
      };
      confirm_mcp_problem_initial_idea: {
        Args: { p_challenge_id: string; p_challenge_token: string };
        Returns: Json;
      };
      consume_device_claim_v3: {
        Args: { p_device_id: string };
        Returns: undefined;
      };
      create_note_study_session_v1: {
        Args: {
          p_candidate_items: Json;
          p_create_fingerprint: string;
          p_create_request_id: string;
          p_cursor: string;
          p_device_id: string;
          p_has_more: boolean;
          p_mode: string;
          p_optional_count: number;
          p_ordering: string;
          p_progress_revision: number;
          p_purpose: string;
          p_scope: Json;
          p_seed: string;
          p_snapshot: Json;
          p_user_id: string;
        };
        Returns: {
          candidate_count: number;
          candidate_items: Json;
          create_fingerprint: string;
          create_request_id: string;
          created_at: string;
          cursor: string | null;
          device_id: string | null;
          domain: string;
          ended_at: string | null;
          expires_at: string;
          has_more: boolean;
          id: string;
          last_activity_at: string;
          mode: string;
          next_sequence: number;
          optional_count: number | null;
          ordering: string;
          progress_revision: number;
          purpose: string;
          scope: Json;
          seed: string;
          snapshot: Json;
          started_at: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'study_sessions';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_word_study_session_v1: {
        Args: {
          p_candidate_items: Json;
          p_create_fingerprint: string;
          p_create_request_id: string;
          p_cursor: string;
          p_device_id: string | null;
          p_domain: string;
          p_has_more: boolean;
          p_mode: string;
          p_optional_count: number;
          p_ordering: string;
          p_progress_revision: number;
          p_purpose: string;
          p_scope: Json;
          p_seed: string;
          p_snapshot: Json;
          p_user_id: string;
        };
        Returns: {
          candidate_count: number;
          candidate_items: Json;
          create_fingerprint: string;
          create_request_id: string;
          created_at: string;
          cursor: string | null;
          device_id: string | null;
          domain: string;
          ended_at: string | null;
          expires_at: string;
          has_more: boolean;
          id: string;
          last_activity_at: string;
          mode: string;
          next_sequence: number;
          optional_count: number | null;
          ordering: string;
          progress_revision: number;
          purpose: string;
          scope: Json;
          seed: string;
          snapshot: Json;
          started_at: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'study_sessions';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      cutover_user_review_schedule_to_fsrs: {
        Args: { p_expected_projections: Json; p_user_id: string };
        Returns: Json;
      };
      fail_problem_mark_annotation: {
        Args: {
          p_error_code: string;
          p_problem_id: string;
          p_semantic_revision: number;
        };
        Returns: undefined;
      };
      fail_problem_mark_annotation_run: {
        Args: { p_error_code: string; p_lease_token: string; p_run_id: string };
        Returns: Json;
      };
      fail_problem_review_projection_job: {
        Args: {
          p_error_code: string;
          p_lease_token: string;
          p_problem_id: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
      find_problem_by_asset: { Args: { p_path: string }; Returns: string };
      generate_username_from_email: {
        Args: { p_email: string };
        Returns: string;
      };
      get_activity_heatmap: {
        Args: { p_user_id: string; p_user_tz?: string };
        Returns: Json;
      };
      get_activity_summary: {
        Args: { p_user_id: string };
        Returns: {
          problems_with_errors: number;
          total_attempts: number;
          total_problems: number;
          total_subjects: number;
        }[];
      };
      get_device_content_revisions: {
        Args: { p_user_id: string };
        Returns: {
          domain: string;
          revision: number;
        }[];
      };
      get_discovery_subject_counts: {
        Args: never;
        Returns: {
          count: number;
          name: string;
        }[];
      };
      get_due_problems_count: {
        Args: never;
        Returns: {
          due_count: number;
          subject_id: string;
        }[];
      };
      get_due_problems_for_subject: {
        Args: { p_limit?: number; p_subject_id: string };
        Returns: {
          assets: Json;
          content: string | null;
          created_at: string;
          embedding: string | null;
          id: string;
          is_optional: boolean;
          last_reviewed_date: string | null;
          parts: Json;
          revision: number;
          semantic_revision: number;
          solution_assets: Json;
          solution_text: string | null;
          source: Json;
          status: Database['public']['Enums']['problem_status_enum'];
          subject_id: string;
          title: string;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'problems';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      get_error_aggregation_data: {
        Args: { p_user_id: string };
        Returns: {
          ai_confidence: number;
          attempt_created_at: string;
          attempt_id: string;
          attempt_selected_status: string;
          broad_category: string;
          categorisation_created_at: string;
          categorisation_id: string;
          granular_tag: string;
          is_user_override: boolean;
          problem_id: string;
          problem_status: string;
          problem_title: string;
          subject_id: string;
          subject_name: string;
          topic_label: string;
          topic_label_normalised: string;
        }[];
      };
      get_problem_mark_annotation_context: {
        Args: { p_problem_id: string };
        Returns: Json;
      };
      get_problem_review_scheduler_diagnostics: {
        Args: { p_problem_id: string };
        Returns: Json;
      };
      get_problem_semantics: { Args: { p_problem_id: string }; Returns: Json };
      get_problem_set_progress: {
        Args: { problem_set_uuid: string; user_uuid: string };
        Returns: {
          mastered_count: number;
          needs_review_count: number;
          total_problems: number;
          wrong_count: number;
        }[];
      };
      get_recent_study_activity: {
        Args: { p_user_id: string };
        Returns: {
          changed_at: string;
          new_status: string;
          old_status: string;
          problem_id: string;
          problem_title: string;
          subject_name: string;
        }[];
      };
      get_session_statistics: { Args: { p_user_id: string }; Returns: Json };
      get_study_streaks: {
        Args: { p_user_id: string; p_user_tz?: string };
        Returns: Json;
      };
      get_subject_breakdown: {
        Args: { p_user_id: string };
        Returns: {
          mastered: number;
          mastery_pct: number;
          needs_review: number;
          subject_id: string;
          subject_name: string;
          total: number;
          wrong: number;
        }[];
      };
      get_subjects_with_metadata: {
        Args: never;
        Returns: {
          color: string;
          created_at: string;
          due_count: number;
          icon: string;
          id: string;
          last_activity: string;
          name: string;
          problem_count: number;
          user_id: string;
        }[];
      };
      get_uncategorised_attempts: {
        Args: { p_limit: number; p_user_id: string };
        Returns: {
          attempt_created_at: string;
          attempt_id: string;
          cause: string;
          is_correct: boolean;
          part_results: Json;
          problem_content: string;
          problem_id: string;
          problem_parts: Json;
          problem_title: string;
          reflection_notes: string;
          selected_status: string;
          subject_id: string;
          subject_name: string;
          submitted_answer: Json;
        }[];
      };
      get_unreferenced_asset_paths: {
        Args: { p_exclude_problem_id: string; p_paths: string[] };
        Returns: string[];
      };
      get_user_statistics:
        | {
            Args: never;
            Returns: {
              active_users: number;
              admin_users: number;
              new_users_this_week: number;
              new_users_today: number;
              total_users: number;
            }[];
          }
        | { Args: { p_user_id: string }; Returns: Json };
      get_user_storage_bytes: { Args: { p_user_id: string }; Returns: number };
      get_recent_note_reads_v2: {
        Args: {
          p_limit?: number;
          p_notebook_id?: string | null;
          p_user_id: string;
        };
        Returns: {
          actor: string;
          completed_count: number;
          last_completed_at: string | null;
          last_opened_at: string;
          note_id: string;
          note_title: string;
          notebook_id: string;
          notebook_title: string;
          state: string;
        }[];
      };
      get_web_note_study_session_v2: {
        Args: { p_session_id: string; p_user_id: string };
        Returns: Json;
      };
      get_weekly_progress: {
        Args: { p_user_id: string; p_user_tz?: string };
        Returns: Json;
      };
      increment_copy_count: {
        Args: { p_problem_set_id: string };
        Returns: undefined;
      };
      inherit_problem_marks: { Args: { p_mappings: Json }; Returns: Json };
      log_user_activity: {
        Args: {
          p_action: string;
          p_details?: Json;
          p_resource_id?: string;
          p_resource_type?: string;
        };
        Returns: string;
      };
      prepare_problem_mark_annotation: {
        Args: {
          p_lease_token: string;
          p_problem_id: string;
          p_semantic_revision: number;
        };
        Returns: Json;
      };
      prepare_problem_review_projection: {
        Args: {
          p_lease_token: string;
          p_problem_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      problem_parts_valid: { Args: { p: Json }; Returns: boolean };
      prune_word_packs_v1: {
        Args: { p_deck_id: string };
        Returns: {
          id: string;
          storage_path: string;
        }[];
      };
      record_note_study_observation_v1: {
        Args: {
          p_action: string;
          p_device_id: string;
          p_item_id: string;
          p_mode: string;
          p_occurred_at: string;
          p_request_id: string;
          p_sequence: number;
          p_session_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      record_web_note_study_observation_v2: {
        Args: {
          p_action: string;
          p_item_id: string;
          p_mode: string;
          p_occurred_at: string;
          p_request_id: string;
          p_sequence: number;
          p_session_id: string;
          p_skip?: boolean;
          p_user_id: string;
        };
        Returns: Json;
      };
      record_problem_review_fact: {
        Args: {
          p_attempt_id: string | null;
          p_channel_source: string;
          p_device_id: string | null;
          p_event_id: string;
          p_event_kind: string;
          p_human_rating: string | null;
          p_initial_idea_revision_id: string | null;
          p_machine_correctness_snapshot: boolean | null;
          p_problem_id: string;
          p_review_occurrence_id: string;
          p_reviewed_at: string;
          p_source_request_id: string;
          p_supersedes_event_id: string | null;
          p_user_id: string;
        };
        Returns: Json;
      };
      record_problem_review_v1: {
        Args: {
          p_action: string;
          p_device_id: string;
          p_occurred_at: string;
          p_problem_id: string;
          p_request_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      record_problem_set_copy: {
        Args: { p_problem_set_id: string; p_user_id: string };
        Returns: undefined;
      };
      record_problem_set_view: {
        Args: {
          p_problem_set_id: string;
          p_user_id?: string;
          p_viewer_hash: string;
        };
        Returns: undefined;
      };
      record_study_observation_v1: {
        Args: {
          p_action: string;
          p_device_id: string | null;
          p_item_id: string;
          p_mode: string;
          p_occurred_at: string;
          p_request_id: string;
          p_sequence: number;
          p_session_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      refresh_ranking_scores: { Args: never; Returns: undefined };
      renew_problem_mark_annotation_lease: {
        Args: {
          p_lease_seconds?: number;
          p_lease_token: string;
          p_problem_id: string;
        };
        Returns: Json;
      };
      requeue_problem_mark_annotation: {
        Args: { p_problem_id: string };
        Returns: Json;
      };
      set_problem_initial_idea: {
        Args: {
          p_idea: string | null;
          p_problem_id: string;
          p_revision_kind: string;
        };
        Returns: Json;
      };
      set_problem_review_idea: {
        Args: {
          p_idea: string | null;
          p_review_occurrence_id: string;
          p_revision_kind: string;
        };
        Returns: Json;
      };
      set_web_note_study_session_status_v1: {
        Args: { p_session_id: string; p_status: string; p_user_id: string };
        Returns: {
          candidate_count: number;
          candidate_items: Json;
          create_fingerprint: string;
          create_request_id: string;
          created_at: string;
          cursor: string | null;
          device_id: string | null;
          domain: string;
          ended_at: string | null;
          expires_at: string;
          has_more: boolean;
          id: string;
          last_activity_at: string;
          mode: string;
          next_sequence: number;
          optional_count: number | null;
          ordering: string;
          progress_revision: number;
          purpose: string;
          scope: Json;
          seed: string;
          snapshot: Json;
          started_at: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'study_sessions';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_web_word_study_session_status_v1: {
        Args: { p_session_id: string; p_status: string; p_user_id: string };
        Returns: {
          candidate_count: number;
          candidate_items: Json;
          create_fingerprint: string;
          create_request_id: string;
          created_at: string;
          cursor: string | null;
          device_id: string | null;
          domain: string;
          ended_at: string | null;
          expires_at: string;
          has_more: boolean;
          id: string;
          last_activity_at: string;
          mode: string;
          next_sequence: number;
          optional_count: number | null;
          ordering: string;
          progress_revision: number;
          purpose: string;
          scope: Json;
          seed: string;
          snapshot: Json;
          started_at: string;
          status: string;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'study_sessions';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      skip_note_study_observation_v1: {
        Args: {
          p_action: string;
          p_device_id: string;
          p_item_id: string;
          p_mode: string;
          p_occurred_at: string;
          p_request_id: string;
          p_sequence: number;
          p_session_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      skip_study_observation_v1: {
        Args: {
          p_action: string;
          p_device_id: string | null;
          p_item_id: string;
          p_mode: string;
          p_occurred_at: string;
          p_request_id: string;
          p_sequence: number;
          p_session_id: string;
          p_user_id: string;
        };
        Returns: Json;
      };
      sync_knowledge_registry: {
        Args: { p_marks: Json; p_subjects: Json };
        Returns: Json;
      };
      sync_knowledge_registry_revision: {
        Args: {
          p_artifact_text: string;
          p_content_sha256: string;
          p_schema_version: number;
          p_source_repository: string;
          p_source_sha: string;
        };
        Returns: Json;
      };
      to_user_date: { Args: { p_ts: string; p_tz?: string }; Returns: string };
      toggle_problem_set_like: {
        Args: { p_problem_set_id: string; p_user_id: string };
        Returns: {
          like_count: number;
          liked: boolean;
        }[];
      };
      user_owns_problem_with_asset: {
        Args: { p_path: string };
        Returns: boolean;
      };
      user_today: { Args: { p_tz?: string }; Returns: string };
    };
    Enums: {
      problem_part_type:
        | 'single_choice'
        | 'multi_choice'
        | 'fill_blank'
        | 'short_answer'
        | 'essay';
      problem_status_enum: 'wrong' | 'needs_review' | 'mastered';
      sharing_level: 'private' | 'limited' | 'public';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  'public'
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] &
        DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] &
        DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      problem_part_type: [
        'single_choice',
        'multi_choice',
        'fill_blank',
        'short_answer',
        'essay',
      ],
      problem_status_enum: ['wrong', 'needs_review', 'mastered'],
      sharing_level: ['private', 'limited', 'public'],
    },
  },
} as const;
