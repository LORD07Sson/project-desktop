
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_date(value: &str) -> Option<i64> {
    let date = value.get(..10)?;
    let mut parts = date.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

#[derive(Deserialize, Clone)]
pub struct BoardCard {
    pub public_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub assignees: serde_json::Value,
    #[serde(default)]
    pub files_count: u32,
    #[serde(default)]
    pub notes_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumnIn {
    pub status: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub reports: Vec<BoardCard>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardView {
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub today: String,
    #[serde(default)]
    pub wip_limits: HashMap<String, u32>,
    #[serde(default)]
    pub stale_after_days: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCardOut {
    pub public_id: String,
    pub title: String,
    pub priority: Option<String>,
    pub deadline: Option<String>,
    pub created_at: Option<String>,
    pub assignees: serde_json::Value,
    pub days_left: Option<i64>,
    pub overdue: bool,
    pub age_days: Option<i64>,
    pub stale: bool,
    pub unassigned: bool,
    pub heat: f64,
    pub files_count: u32,
    pub notes_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumnOut {
    pub status: String,
    pub label: String,
    pub total: u32,
    pub has_more: bool,
    pub shown: u32,
    pub overdue: u32,
    pub unassigned: u32,
    pub stale: u32,
    pub avg_age_days: Option<i64>,
    pub wip_limit: Option<u32>,
    pub over_wip: bool,
    pub cards: Vec<BoardCardOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardLayout {
    pub columns: Vec<BoardColumnOut>,
    pub filtered_out: u32,
    pub total_overdue: u32,
    pub total_stale: u32,
}

const PRIORITY_WEIGHT: &[(&str, f64)] = &[
    ("urgent", 1.0),
    ("high", 0.66),
    ("normal", 0.33),
    ("low", 0.0),
];

fn priority_weight(priority: Option<&str>) -> f64 {
    let p = priority.unwrap_or("normal");
    PRIORITY_WEIGHT
        .iter()
        .find(|(name, _)| *name == p)
        .map(|(_, w)| *w)
        .unwrap_or(0.33)
}

fn heat(days_left: Option<i64>, priority: Option<&str>, age_days: Option<i64>, stale_after: i64) -> f64 {
    let p = priority_weight(priority) * 0.4;
    let deadline = match days_left {
        Some(d) if d < 0 => 0.45,
        Some(d) => (0.45 * (1.0 - (d as f64 / 14.0)).clamp(0.0, 1.0)).max(0.0),
        None => 0.0,
    };
    let stale = match age_days {
        Some(a) if stale_after > 0 => (0.15 * (a as f64 / stale_after as f64)).clamp(0.0, 0.15),
        _ => 0.0,
    };
    (p + deadline + stale).clamp(0.0, 1.0)
}

fn is_unassigned(assignees: &serde_json::Value) -> bool {
    match assignees {
        serde_json::Value::Array(a) => a.is_empty(),
        serde_json::Value::Null => true,
        _ => false,
    }
}

fn matches_query(card: &BoardCard, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    card.public_id.to_lowercase().contains(needle) || card.title.to_lowercase().contains(needle)
}

pub fn layout(columns: Vec<BoardColumnIn>, view: &BoardView) -> BoardLayout {
    let today = parse_date(&view.today);
    let needle = view.query.trim().to_lowercase();
    let stale_after = if view.stale_after_days > 0 { view.stale_after_days } else { 7 };

    let mut filtered_out = 0u32;
    let mut total_overdue = 0u32;
    let mut total_stale = 0u32;
    let mut out_columns = Vec::with_capacity(columns.len());

    for col in columns {
        let mut cards = Vec::with_capacity(col.reports.len());
        let mut age_sum = 0i64;
        let mut age_count = 0i64;
        let (mut overdue_n, mut unassigned_n, mut stale_n) = (0u32, 0u32, 0u32);

        for card in col.reports {
            if !matches_query(&card, &needle) {
                filtered_out += 1;
                continue;
            }
            let days_left = match (today, card.deadline.as_deref().and_then(parse_date)) {
                (Some(t), Some(d)) => Some(d - t),
                _ => None,
            };
            let age_days = match (today, card.updated_at.as_deref().and_then(parse_date)) {
                (Some(t), Some(u)) => Some((t - u).max(0)),
                _ => None,
            };
            let terminal = matches!(col.status.as_str(), "completed" | "cancelled");
            let overdue = !terminal && days_left.map(|d| d < 0).unwrap_or(false);
            let stale = !terminal && age_days.map(|a| a >= stale_after).unwrap_or(false);
            let unassigned = is_unassigned(&card.assignees);

            if overdue { overdue_n += 1; total_overdue += 1; }
            if stale { stale_n += 1; total_stale += 1; }
            if unassigned { unassigned_n += 1; }
            if let Some(a) = age_days { age_sum += a; age_count += 1; }

            cards.push(BoardCardOut {
                public_id: card.public_id,
                title: card.title,
                heat: if terminal { 0.0 } else { heat(days_left, card.priority.as_deref(), age_days, stale_after) },
                priority: card.priority,
                deadline: card.deadline,
                created_at: card.created_at,
                assignees: card.assignees,
                days_left,
                overdue,
                age_days,
                stale,
                unassigned,
                files_count: card.files_count,
                notes_count: card.notes_count,
            });
        }

        sort_cards(&mut cards, &view.sort);

        let wip_limit = view.wip_limits.get(&col.status).copied();
        out_columns.push(BoardColumnOut {
            over_wip: wip_limit.map(|l| col.total > l).unwrap_or(false),
            wip_limit,
            status: col.status,
            label: col.label,
            total: col.total,
            has_more: col.has_more,
            shown: cards.len() as u32,
            overdue: overdue_n,
            unassigned: unassigned_n,
            stale: stale_n,
            avg_age_days: (age_count > 0).then(|| age_sum / age_count),
            cards,
        });
    }

    BoardLayout { columns: out_columns, filtered_out, total_overdue, total_stale }
}

fn sort_cards(cards: &mut [BoardCardOut], sort: &str) {
    match sort {
        "none" => {}
        "deadline" => cards.sort_by(|a, b| {
            let key = |c: &BoardCardOut| c.days_left.unwrap_or(i64::MAX);
            key(a).cmp(&key(b)).then_with(|| a.public_id.cmp(&b.public_id))
        }),
        "priority" => cards.sort_by(|a, b| {
            priority_weight(b.priority.as_deref())
                .partial_cmp(&priority_weight(a.priority.as_deref()))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.public_id.cmp(&b.public_id))
        }),
        "age" => cards.sort_by(|a, b| {
            let key = |c: &BoardCardOut| c.age_days.unwrap_or(-1);
            key(b).cmp(&key(a)).then_with(|| a.public_id.cmp(&b.public_id))
        }),
        _ => cards.sort_by(|a, b| {
            b.overdue
                .cmp(&a.overdue)
                .then_with(|| b.heat.partial_cmp(&a.heat).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.public_id.cmp(&b.public_id))
        }),
    }
}
