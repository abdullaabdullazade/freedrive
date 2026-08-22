package domain

import "time"

// Folder represents a directory in the virtual file system.
type Folder struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	ParentID  *string    `json:"parent_id,omitempty"`
	OwnerID   string     `json:"owner_id"`
	Color     string     `json:"color,omitempty"`
	IsStarred bool       `json:"is_starred"`
	IsTrashed bool       `json:"is_trashed"`
	TrashedAt *time.Time `json:"trashed_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
}

// FolderContents represents a folder with its child items.
type FolderContents struct {
	Folder        *Folder  `json:"folder"`
	Folders       []Folder `json:"folders"`
	Files         []File   `json:"files"`
	NextPageToken string   `json:"next_page_token,omitempty"`
	TotalFiles    int      `json:"total_files,omitempty"`
}

// FolderContentsOptions controls file pagination for GetContents.
// Child folders are always returned in full on the first page (offset 0).
type FolderContentsOptions struct {
	PageSize  int
	PageToken string
}

// Breadcrumb represents one segment in a folder path.
type Breadcrumb struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
