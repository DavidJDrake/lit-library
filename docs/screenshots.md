# Capturing the README screenshots

The images themselves are not in the repository yet. This is the recipe for taking
them, written down so they can be retaken consistently when the interface changes.

## Privacy: shoot the public-domain shelf

The library's real contents say something about what you have bought, and this
repository is public. Every capture below starts from a view filtered to the
Project Gutenberg bundle, so every visible title is public-domain fiction.

```
https://lit.davidjdrake.com/?bundle=Weird+Fiction+the+Lovecraft+Circle+by+Project+Gutenberg&sort=title
```

That is 109 books, enough to fill a grid convincingly.

The header shows your email address. Before capturing, blank it in the browser's
developer console:

```js
document.querySelectorAll('*').forEach(el => {
  el.childNodes.forEach(n => {
    if (n.nodeType === 3 && n.nodeValue.includes('@'))
      n.nodeValue = n.nodeValue.replace(/\S+@\S+\.\w+/g, 'you@example.com');
  });
});
```

It reverts on reload, so it cannot leak into anything but the image.

## The four worth having

Save each as PNG into `docs/images/`, at a window width of about 1400 pixels so
the grid shows four or five columns.

| File | View | Why it earns its place |
|---|---|---|
| `library.png` | The filtered grid above | The product in one glance: covers, facets, counts, search |
| `book.png` | Any book opened | Where the features live: download, send to Kindle, category, reading status |
| `settings.png` | `/settings` | Kindle devices and the OPDS feed link, with the token blanked the same way |
| `notifications.png` | The bell popover, opened | The part people do not expect a personal library to have |

For the settings capture, blank the feed token as well as the email. Anyone holding
that link can read the whole library.

## Then add them to the README

Put this immediately after the opening paragraph, above "What it does":

```markdown
| | |
|---|---|
| ![The library](docs/images/library.png) | ![A book](docs/images/book.png) |
| ![Settings](docs/images/settings.png) | ![Notifications](docs/images/notifications.png) |
```

A two-by-two table keeps them legible without any one dominating the page. Add
short alt text describing what each shows, since it is the only description a
screen reader gets.
