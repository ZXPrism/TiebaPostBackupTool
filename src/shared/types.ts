// A post must have the first floor
// The author of the first floor is the author of this post
export interface Post {
    title: string,
    tieba_name: string,
    tieba_url: string, // Link to the tieba homepage
    id: number, // i.e. https://tieba.baidu.com/p/{id}
    page_cnt: number,
    comment_cnt: number,
    floor_list: Floor[],
    image_map?: ImageMap, // Mapping of original URLs to new names
    backup_date?: string, // ISO 8601 export timestamp; absent in older backups.
}

export interface Floor {
    comment: Comment,
    index: number,
    sub_comment_list?: Comment[]
}

export interface Comment {
    author: string,
    date: string,
    content: string, // may contain HTML tags
    ip_location?: string,
    avatar_url?: string, // New name for user avatar (referenced in image_map)
    homepage_url?: string, // Link to user's homepage on Tieba
    reply_to_author?: string, // Name of the user being replied to (if any)
    reply_to_homepage_url?: string, // Homepage of the user being replied to (if any)
}

export interface ImageMap {
    [original_url: string]: string, // Identical downloaded images may share the same local filename.
}
