# x-bookmark-to-md

`x-bookmark-to-md` is a Chrome extension that allows you to export your X (formerly Twitter) bookmarks into individual Markdown files, bundled together in a single ZIP archive.

## Features

-   **Export All Bookmarks**: Scrapes all bookmarks from your X bookmarks page.
-   **Markdown Format**: Saves each bookmark as a clean, readable Markdown file.
-   **Includes Tweet Content**: Captures the full text, author information, date, and original URL of the tweet.
-   **Media and Links**: Includes images and links from the tweet.
-   **ZIP Archive**: Downloads all Markdown files conveniently in a single ZIP file, including an index file for easy navigation.

## How to Use

1.  **Install the Extension**:
    *   Download or clone this repository.
    *   Open Chrome and navigate to `chrome://extensions/`.
    *   Enable "Developer mode" in the top right corner.
    *   Click "Load unpacked" and select this repository folder (e.g. `x-bookmark-to-md`).

2.  **Export Your Bookmarks**:
    *   Navigate to your X bookmarks page (`https://x.com/i/bookmarks`).
    *   Click the extension icon in the Chrome toolbar.
    *   Click the "Export Bookmarks" button.
    *   The extension will scroll through your bookmarks to collect all data. Please wait for this process to complete.
    *   Once finished, a `Save As` dialog will appear, allowing you to save the ZIP file containing your bookmarks.

## File Structure

The downloaded ZIP file will contain:

-   `Bookmark @username_001.md`: Individual Markdown files for each bookmark.
-   `index.md`: A main file that lists all exported bookmarks for quick access.

Each Markdown file includes:
-   Author and username
-   Date and time of the tweet
-   Link to the original tweet
-   Full text of the tweet
-   Embedded images
-   Links included in the tweet

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any bugs or feature requests.

## License

This project is open-source and available under the [MIT License](LICENSE).