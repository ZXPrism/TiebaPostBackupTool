export interface Post {
    postInfo: PostInfo,
    replies: MainReply[]
};

export interface PostInfo {
    postTitle: string,
    postTieba: string,
    postID: string,
    postPageNum: number,
    postCurrPage: number,
    postReplyNum: number
};

export interface MainReply {
    author: string
    replyTime: string,
    replyContent: string,
    floor: number,
    subReplies: SubReply[]
};

export interface SubReply {
    author: string,
    replyTime: string,
    replyContent: string
};
