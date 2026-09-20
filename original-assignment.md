# Original assignment — Inventory Management System

The source project for this repository: an Object-Oriented Programming
assignment implementing an Inventory Management System in Java with a Swing
GUI.

## Concepts demonstrated

- Inheritance
- GUI (Graphical User Interface)
- Method overriding
- ArrayList
- Encapsulation
- User-defined exceptions
- Abstract classes and interfaces

## Original class structure

```
InventoryItem (abstract)
  ├── PerishableItem      + expirationDate, isExpired(), getDetails() override
  └── NonPerishableItem                                  getDetails() override

InventoryManager          ArrayList<InventoryItem>, totalRevenue
Owner                     username, password
InventoryGUI              Swing frames for both roles
```

## Original features

**Owner role** (after login): add item, view items, remove item, reduce
quantity, view revenue, check low stock against a user-entered threshold,
check expired items.

**Customer role**: search an item by name, buy an item.

## What this repository changed, and why

| Original | Now | Reason |
|---|---|---|
| `purchase()` printed to stdout, returned `boolean` | throws `InsufficientStockException` | a returned boolean can be ignored by forgetting to check it; an exception cannot |
| Low stock = quantity below a typed-in number | stockout probability over the supplier's lead time | a fixed threshold ignores how fast the item sells and how long the supplier takes; the two rules disagree for most of the catalogue |
| Expired = date has passed | expected spoilage in units and dollars | "it expired" is known too late to act on; "270 units will be left on Friday" is actionable today |
| Revenue total | ABC segmentation by annualised margin | tells you which items justify attention |
| Swing GUI | browser front end + JSON API | runs anywhere, and separates the model from its presentation |
| Names lowercased in the constructor | names preserved | the original did `name.toLowerCase()` in `InventoryItem`, then compared with `equals(name.toLowerCase())` in `buyItem` and `equalsIgnoreCase` in search — matching worked by coincidence of which path was taken. Case handling now lives in the comparison, not the stored data |
| Plaintext password field | hashed, and labelled as not production-grade | keeps plaintext out of the field while being explicit that `String.hashCode()` is not password hashing |

The class hierarchy itself is unchanged: `InventoryItem` is still abstract with
two concrete subclasses overriding `getDetails()`, stock is still private and
reachable only through validating methods, and the user-defined exception is
still user-defined.

## Original source

The full original source listing is in the submitted PDF
(`OOPS Project.pdf`), 23 pages, including the Swing implementation of both
role menus.
