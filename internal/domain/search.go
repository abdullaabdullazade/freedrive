package domain

import "time"

// SearchOptions contains filters for advanced drive search.
type SearchOptions struct {
	Query       string
	Name        string
	Words       string
	Type        string
	Owner       string // Anyone, Me, Not me, Specific person
	OwnerEmail  string
	Location    string // Anywhere, My Drive, Shared with me, Computers, More locations
	InTrash     bool
	Starred     bool
	Encrypted   bool
	ModifiedAfter  *time.Time
	ModifiedBefore *time.Time
	SharedTo    string
	ApprovalAwaiting  bool
	ApprovalRequested bool
	FollowUps   string // -, Any, Suggestions only, Comments assigned to me only
	Page        int
	PageSize    int
}

// SearchResult is the combined advanced search response.
type SearchResult struct {
	Files   []File
	Folders []Folder
	Total   int
	Page    int
}
