# Product Requirements Document (PRD)

## AI Course Builder (MVP)

Version: 1.0
Platform: Desktop (Tauri)
Status: MVP

---

## 1. Overview

### Problem

Course creators spend hours converting long lecture recordings into structured lessons.

The current workflow requires manually:

* Watching entire recordings
* Finding lesson boundaries
* Removing Q&A and irrelevant discussions
* Splitting videos into multiple lessons
* Exporting each lesson individually

Editing a course with 75–100 recordings can take several days.

---

## 2. Goal

Build a local-first AI desktop application that converts long lecture recordings into polished lesson videos.

Videos never leave the user's computer.

Only extracted audio (for transcription) and transcript text (for AI analysis) may be sent to OpenAI.

---

## 3. Target Users

* Course creators
* Educators
* Coaches
* EdTech companies
* Corporate training teams

---

## 4. Success Metrics

* Reduce editing time by 80%+
* Support projects with 100+ recordings
* Enable batch export of lessons
* Eliminate timeline editing for the majority of use cases

---

## 5. Tech Stack

### Desktop

* Tauri v2
* React
* TypeScript
* Vite

### Database

* SQLite

### Video

* MediaBunny
* FFmpeg

### AI

* OpenAI Whisper API
* GPT-5.5

---

## 6. Core Workflow

```
Create Project
        ↓
Import Videos
        ↓
Extract Audio (Local)
        ↓
OpenAI Whisper
        ↓
Transcript
        ↓
GPT-5.5 Analysis
        ↓
Lesson Suggestions
        ↓
Review & Edit
        ↓
Export
```

---

## 7. Functional Requirements

### 7.1 Project Management

Features

* Create Project
* Open Project
* Delete Project
* Duplicate Project
* Recent Projects
* Autosave
* Resume Previous Session

Each project stores:

* Videos
* Transcripts
* AI analysis
* Lessons
* Export history
* User settings

---

### 7.2 Import

Support:

* Single video
* Multiple videos
* Folder import
* Drag & drop

Supported formats:

* MP4
* MOV
* MKV
* AVI
* M4V

Videos remain in their original location.

---

### 7.3 Audio Extraction

Extract audio locally using FFmpeg.

* No video files cleaned after processing

---

### 7.4 Transcription

Use OpenAI Whisper API.

Store:

* Transcript
* Sentence timestamps
* Word timestamps (if available)
* Language

Cache transcripts locally.

Never retranscribe unchanged videos.

---

### 7.5 AI Analysis

Use GPT-5.5 to generate:

* Lesson boundaries
* Lesson titles
* Lesson summaries
* Q&A detection
* Discussion detection
* Break detection
* Silence detection
* Duplicate explanation detection

Every suggestion includes a confidence score.

---

## 8. Editing

### 8.1 Transcript Mode (Primary)

Primary editing interface.

Features:

* Video synchronized with transcript
* Keep/Delete transcript blocks
* Split lessons
* Merge lessons
* Rename lessons
* Search transcript
* AI suggestions
* Undo/Redo

Users should rarely need to touch a timeline.

---

### 8.2 Timestamp Mode (Fallback)

For cases where transcript editing is inaccurate.

Features:

* Preview video
* Set Start Time
* Set End Time
* Split at Playhead
* Trim Start
* Trim End
* Frame-accurate preview
* Keyboard shortcuts

This is a lightweight precision editor, not a full video editor.

---

## 9. Lesson Management

Each lesson stores:

* Title
* Summary
* Source video
* Start time
* End time
* Transcript
* Duration

User actions:

* Preview
* Rename
* Split
* Merge
* Delete
* Reorder

---

## 10. Export

### Export Types

* Single lesson
* Multiple selected lessons
* Entire recording
* Entire project

### Output

* MP4
* SRT subtitles

### Export Queue Features

* Pause
* Resume
* Retry failed exports
* Cancel exports
* Progress tracking

---

## 11. Export History

Store every export.

Metadata:

* Date & time
* Output folder
* Export settings
* Status
* Duration

Allow users to re-export any lesson.

---

## 12. Session Persistence

Persist:

* Projects
* Imported videos
* Transcripts
* AI analysis
* User edits
* Lesson structure
* Export history
* Playback position

No work should be lost after closing or reopening the application.

---

## 13. Data Model

### Project

* id
* name
* createdAt
* updatedAt

### Video

* id
* projectId
* filePath
* duration
* transcriptStatus

### Transcript Segment

* id
* videoId
* start
* end
* text
* keep

### Lesson

* id
* videoId
* title
* summary
* start
* end

### Export

* id
* lessonId
* outputPath
* status
* createdAt

> Implemented in `src-tauri/migrations/0001_init.sql` — see [`coursecut-data-model`](../.claude/skills/coursecut-data-model/SKILL.md) skill for the actual columns (adds timestamps/status/sort_order housekeeping fields not spelled out above).

---

## 14. Processing Pipeline

```
Import Video
        ↓
Extract Audio (FFmpeg)
        ↓
OpenAI Whisper
        ↓
Transcript
        ↓
GPT-5.5
        ↓
Lesson Detection
        ↓
User Review
        ↓
Export Queue
        ↓
FFmpeg
```

---

## 15. Non-Functional Requirements

* Local-first architecture
* Videos never uploaded
* Cross-platform (macOS & Windows)
* Background processing
* Autosave
* Resume interrupted jobs
* Cached transcripts
* Cached AI analysis
* Keyboard shortcuts
* Dark mode
* Crash recovery

---

## 16. Out of Scope (MVP)

* Traditional timeline editor
* Multi-track editing
* Motion graphics
* Effects & transitions
* Color grading
* Audio mixing
* Screen recording
* Cloud storage
* Team collaboration

---

## 17. Product Principles

1. **Local First** — Videos never leave the user's computer.
2. **Transcript First** — Text is the primary editing interface.
3. **Timestamp Backup** — Precise trimming and splitting is always available.
4. **AI-Assisted** — AI suggests; users review and approve.
5. **Batch First** — Optimized for processing entire courses, not single videos.
6. **Non-Destructive** — Original recordings are never modified.
7. **Persistent** — Every project, edit, transcript, and export is automatically saved.

---

## 18. MVP Definition

The MVP is successful when a user can:

1. Create a project.
2. Import one or more lecture recordings.
3. Transcribe recordings using OpenAI Whisper.
4. Receive AI-generated lesson suggestions.
5. Edit lessons using:
    * Transcript-based editing (primary)
    * Timestamp-based trimming and splitting (fallback)
6. Preview lessons before export.
7. Export one, multiple, or all lessons as MP4 files.
8. Reopen the application and continue exactly where they left off.

---

## Core Value Proposition

AI Course Builder is not a general-purpose video editor.

It is an AI-powered, transcript-first course production tool that helps educators transform long lecture recordings into structured, export-ready lesson videos with minimal manual editing while keeping their source videos local and private.
