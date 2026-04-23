import { Parser } from './parser';
import { Post } from './types';

/**
 * Modal UI for download progress
 */
class DownloadModal {
    private modal: HTMLDivElement;
    private progress_bar: HTMLDivElement;
    private progress_text: HTMLDivElement;
    private summary_text: HTMLDivElement;

    constructor() {
        // Create modal overlay
        this.modal = document.createElement('div');
        this.modal.id = 'tieba-download-modal';
        this.modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;

        // Create modal content
        const content = document.createElement('div');
        content.style.cssText = `
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            max-width: 500px;
            width: 90%;
        `;

        // Title
        const title = document.createElement('h2');
        title.textContent = '备份完成';
        title.style.cssText = `
            margin: 0 0 20px 0;
            color: #333;
            text-align: center;
        `;

        // Summary text
        this.summary_text = document.createElement('div');
        this.summary_text.style.cssText = `
            margin-bottom: 20px;
            color: #666;
            line-height: 1.6;
        `;

        // Progress container
        const progress_container = document.createElement('div');
        progress_container.style.cssText = `
            margin-bottom: 15px;
        `;

        // Progress bar background
        const progress_bg = document.createElement('div');
        progress_bg.style.cssText = `
            width: 100%;
            height: 24px;
            background: #e0e0e0;
            border-radius: 12px;
            overflow: hidden;
            position: relative;
        `;

        // Progress bar fill
        this.progress_bar = document.createElement('div');
        this.progress_bar.style.cssText = `
            height: 100%;
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            width: 0%;
            transition: width 0.3s ease;
        `;

        // Progress text overlay
        const progress_overlay = document.createElement('div');
        progress_overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 12px;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        `;
        progress_overlay.id = 'tieba-progress-overlay';
        progress_overlay.textContent = '0%';

        // Status text
        this.progress_text = document.createElement('div');
        this.progress_text.style.cssText = `
            text-align: center;
            color: #999;
            font-size: 14px;
            margin-top: 10px;
        `;

        // Assemble
        progress_bg.appendChild(this.progress_bar);
        progress_bg.appendChild(progress_overlay);
        progress_container.appendChild(progress_bg);
        content.appendChild(title);
        content.appendChild(this.summary_text);
        content.appendChild(progress_container);
        content.appendChild(this.progress_text);
        this.modal.appendChild(content);
        document.body.appendChild(this.modal);
    }

    /**
     * Show modal with summary info
     */
    public show(post: Post, image_count: number): void {
        this.summary_text.innerHTML = `
            <div><strong>贴子标题:</strong> ${post.title}</div>
            <div><strong>贴吧:</strong> ${post.tieba_name}</div>
            <div><strong>楼层:</strong> ${post.floor_list.length}</div>
            <div><strong>回复:</strong> ${post.comment_cnt}</div>
            <div><strong>图片:</strong> ${image_count}</div>
        `;
        this.modal.style.display = 'flex';
        this.progress_text.textContent = '正在下载图片...';
    }

    /**
     * Update progress bar
     */
    public update_progress(current: number, total: number, filename: string): void {
        const percentage = Math.round((current / total) * 100);
        this.progress_bar.style.width = `${percentage}%`;

        const overlay = document.getElementById('tieba-progress-overlay');
        if (overlay) {
            overlay.textContent = `${percentage}%`;
        }

        this.progress_text.textContent = `正在下载: ${filename} (${current}/${total})`;
    }

    /**
     * Hide modal
     */
    public hide(): void {
        this.modal.style.display = 'none';
    }

    /**
     * Show complete message
     */
    public show_complete(filename: string): void {
        this.progress_text.textContent = `✅ 备份完成! 正在下载: ${filename}`;
        this.progress_bar.style.width = '100%';

        const overlay = document.getElementById('tieba-progress-overlay');
        if (overlay) {
            overlay.textContent = '100%';
        }
    }
}

// Global modal instance
let download_modal: DownloadModal | null = null;

/**
 * Main backup function
 */
async function backup_post() {
    const backup_button = document.getElementById('tieba-backup-btn') as HTMLButtonElement;

    try {
        const parser = new Parser();

        // Update button state
        if (backup_button) {
            backup_button.textContent = '备份中...';
            backup_button.disabled = true;
        }

        const post = await parser.parse_post();

        // If we get here, parsing is complete

        // Initialize modal if not exists
        if (!download_modal) {
            download_modal = new DownloadModal();
        }

        // Get image handler and show modal
        const image_handler = parser.get_image_handler();
        // Access private property for image count
        const image_map = (image_handler as unknown as { image_map: Record<string, string> }).image_map || {};
        const image_count = Object.keys(image_map).length;
        download_modal.show(post, image_count);

        // Download images with progress callback
        const image_blobs = await image_handler.download_images((current, total, filename) => {
            if (download_modal) {
                download_modal.update_progress(current, total, filename);
            }
        });

        // Create viewer HTML
        const viewer_html = image_handler.create_viewer_html(post);

        // Create JSON data
        const json_data = JSON.stringify(post, null, 2);

        // Package everything into tar
        const files: { [filename: string]: string | Blob } = {
            'post.json': json_data,
            'viewer.html': viewer_html,
        };

        // Add image files with images/ prefix
        for (const [name, blob] of Object.entries(image_blobs)) {
            files[`images/${name}`] = blob;
        }

        const tar_blob = await image_handler.create_tar(files);

        // Trigger download
        const filename = `${post.tieba_name}_${post.id}.tar`;

        // Show complete message
        if (download_modal) {
            download_modal.show_complete(filename);
        }

        // Small delay before actual download
        await new Promise(resolve => setTimeout(resolve, 500));

        image_handler.download_blob(tar_blob, filename);

        // Hide modal after download
        setTimeout(() => {
            if (download_modal) {
                download_modal.hide();
            }
        }, 2000);

        // Reset button
        if (backup_button) {
            backup_button.textContent = '备份本贴';
            backup_button.disabled = false;
        }

        return post;
    } catch (error) {
        // Check if this is a navigation error (normal for multi-page)
        if (error instanceof Error && error.message === 'NAVIGATING') {
            return undefined as unknown as Post; // Will navigate, script will reload on next page
        }

        // Store error for debugging
        if (error instanceof Error) {
            const error_info = {
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString(),
                url: window.location.href,
                user_agent: navigator.userAgent
            };
            // Store in Tampermonkey storage
            (window as unknown as { GM_setValue: (key: string, value: unknown) => void }).GM_setValue('last_error', error_info);
        }

        // Hide modal on error
        if (download_modal) {
            download_modal.hide();
        }

        // Re-enable button on error
        if (backup_button) {
            backup_button.textContent = '备份失败';
            setTimeout(() => {
                backup_button.textContent = '备份本贴';
                backup_button.disabled = false;
            }, 2000);
        }

        // Show view error button
        show_view_error_button();

        throw error;
    }
}

/**
 * Inject backup button into page
 */
function inject_backup_button() {
    // Check if buttons already exist
    if (document.getElementById('tieba-backup-btn')) {
        return;
    }

    // Create container for buttons
    const container = document.createElement('div');
    container.id = 'tieba-backup-container';
    container.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        gap: 10px;
    `;

    // Create backup button
    const backup_button = document.createElement('button');
    backup_button.id = 'tieba-backup-btn';
    backup_button.textContent = '备份本贴';
    backup_button.style.cssText = `
        padding: 10px 20px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        font-weight: bold;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        transition: all 0.3s ease;
    `;

    // Hover effect for backup button
    backup_button.addEventListener('mouseenter', () => {
        backup_button.style.transform = 'translateY(-2px)';
        backup_button.style.boxShadow = '0 6px 12px rgba(0, 0, 0, 0.15)';
    });

    backup_button.addEventListener('mouseleave', () => {
        backup_button.style.transform = 'translateY(0)';
        backup_button.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
    });

    // Click handler
    backup_button.addEventListener('click', () => {
        backup_post();
    });

    // Create reset button
    const reset_button = document.createElement('button');
    reset_button.id = 'tieba-reset-btn';
    reset_button.textContent = '重置状态';
    reset_button.style.cssText = `
        padding: 8px 16px;
        background: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        transition: all 0.3s ease;
        opacity: 0.8;
    `;

    // Hover effect for reset button
    reset_button.addEventListener('mouseenter', () => {
        reset_button.style.transform = 'translateY(-2px)';
        reset_button.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.15)';
        reset_button.style.opacity = '1';
    });

    reset_button.addEventListener('mouseleave', () => {
        reset_button.style.transform = 'translateY(0)';
        reset_button.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.1)';
        reset_button.style.opacity = '0.8';
    });

    // Click handler for reset
    reset_button.addEventListener('click', () => {
        const parser = new Parser();
        parser.reset_parsing();

        // Visual feedback
        reset_button.textContent = '已重置';
        setTimeout(() => {
            reset_button.textContent = '重置状态';
        }, 1000);
    });

    // Add buttons to container
    container.appendChild(backup_button);
    container.appendChild(reset_button);

    // Add container to page
    document.body.appendChild(container);

}

/**
 * Auto-resume parsing if state exists
 */
function auto_resume_if_needed() {
    const parser = new Parser();

    if (parser.is_parsing_in_progress()) {

        // Show reset button is available
        const reset_button = document.getElementById('tieba-reset-btn') as HTMLButtonElement;
        if (reset_button) {
            reset_button.style.opacity = '1';
            reset_button.style.fontWeight = 'bold';
        }

        // Auto-resume after 2 seconds
        setTimeout(() => {
            if (parser.is_parsing_in_progress()) { // Double-check it wasn't reset
                backup_post();
            }
        }, 2000);

        return true;
    }

    return false;
}

/**
 * Show view error button to help debug issues.
 */
function show_view_error_button(): void {
    // Check if button already exists
    if (document.getElementById('tieba-view-error-btn')) {
        return;
    }

    const container = document.getElementById('tieba-backup-container');
    if (!container) {
        return;
    }

    // Create view error button
    const error_button = document.createElement('button');
    error_button.id = 'tieba-view-error-btn';
    error_button.textContent = '查看错误';
    error_button.style.cssText = `
        padding: 8px 16px;
        background: #ff4444;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        font-weight: bold;
        opacity: 0.9;
    `;

    error_button.addEventListener('click', () => {
        const error_data = (window as unknown as { GM_getValue: (key: string, default_value: unknown) => unknown }).GM_getValue('last_error', undefined) as {
            message: string;
            stack: string;
            timestamp: string;
            url: string;
            user_agent: string;
        } | undefined;

        if (!error_data) {
            alert('没有错误信息');
            return;
        }

        const error_text = `
错误信息: ${error_data.message}

时间: ${error_data.timestamp}

页面: ${error_data.url}

浏览器: ${error_data.user_agent}

堆栈:
${error_data.stack}
        `.trim();

        alert(error_text);
    });

    // Insert before reset button
    const reset_button = document.getElementById('tieba-reset-btn');
    if (reset_button) {
        container.insertBefore(error_button, reset_button);
    } else {
        container.appendChild(error_button);
    }

    // Auto-hide after 30 seconds
    setTimeout(() => {
        error_button.remove();
    }, 30000);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        inject_backup_button();
        auto_resume_if_needed();
    });
} else {
    inject_backup_button();
    auto_resume_if_needed();
}

// Also make it available globally for console testing
(window as unknown as { backup_post: typeof backup_post }).backup_post = backup_post;
