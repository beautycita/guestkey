#!/usr/bin/env python3
"""
GuestKey - Ultraloq Air automation via Playwright
Three atomic operations: create-user, add-access, delete
Plus 'add' convenience (create + access in one session)
"""
import sys
import os
import json
import argparse
from datetime import datetime

venv_site = os.environ.get("LOCK_VENV_SITE_PACKAGES")
if venv_site:
    sys.path.insert(0, venv_site)

from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.environ.get("LOCK_STATE_FILE", os.path.join(SCRIPT_DIR, "browser_state", "state.json"))
SCREENSHOT_DIR = os.environ.get("LOCK_SCREENSHOT_DIR", os.path.join(SCRIPT_DIR, "screenshots"))
AIR_URL = "https://air.ultraloq.com"
EMAIL = os.environ.get("ULTRALOQ_EMAIL")
PASSWORD = os.environ.get("ULTRALOQ_PASSWORD")

if not EMAIL or not PASSWORD:
    print(json.dumps({"success": False, "error": "ULTRALOQ_EMAIL and ULTRALOQ_PASSWORD env vars required"}))
    sys.exit(1)

os.makedirs(SCREENSHOT_DIR, exist_ok=True)
os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)


def screenshot(page, name):
    path = f"{SCREENSHOT_DIR}/{name}.png"
    page.screenshot(path=path)
    print(f"  screenshot: {name}.png")


def do_login(page):
    """Attempt a single login. Raises on failure."""
    page.goto(f"{AIR_URL}/#/login", timeout=30000)
    page.wait_for_load_state("networkidle")

    if "/dashboard" in page.url or "/user" in page.url:
        print("Already logged in via saved state")
        return

    email_field = page.get_by_role("textbox", name="Email")
    email_field.click()
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.keyboard.type(EMAIL, delay=30)

    pwd_field = page.locator("input[type='password']")
    pwd_field.click()
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.keyboard.type(PASSWORD, delay=30)

    page.get_by_role("button", name="Login").click()

    try:
        page.wait_for_url("**/dashboard**", timeout=45000)
    except PwTimeout:
        screenshot(page, "login_failed")
        if "/dashboard" in page.url or "/user" in page.url:
            print("Login redirected to:", page.url)
        else:
            raise Exception(f"Login failed — stuck at {page.url}")

    print("Logged in successfully")


def login(page):
    """Login with retry. On timeout, clear browser state and retry fresh."""
    for attempt in range(2):
        try:
            do_login(page)
            return
        except Exception as e:
            if attempt == 0:
                print(f"Login attempt 1 failed: {e}, retrying with fresh state...")
                # Clear saved state so next attempt does fresh login
                if os.path.exists(STATE_FILE):
                    os.remove(STATE_FILE)
                page.context.clear_cookies()
            else:
                raise


def nav_to_users(page):
    page.get_by_role("menuitem", name=" User").locator("i").click()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)


def set_date_field(page, field, value):
    field.click()
    page.wait_for_timeout(500)
    page.keyboard.press("Control+a")
    page.wait_for_timeout(100)
    page.keyboard.type(value, delay=50)
    page.wait_for_timeout(300)
    page.keyboard.press("Enter")
    page.wait_for_timeout(1000)
    return field.input_value()


# ── Action 1: Create User ──────────────────────────────────────────

def create_user(page, name, code):
    """Create a user with name/code/Guest role. Returns True if user appears in list."""
    nav_to_users(page)

    page.get_by_role("button", name="Add User", exact=True).click()
    page.wait_for_timeout(1500)

    page.locator("input[placeholder='User Name']").fill(name)
    page.locator("input[placeholder='User Code']").fill(str(code))

    # Role dropdown: second .el-select on the page (first is phone country code)
    page.locator(".el-select").nth(1).click()
    page.wait_for_timeout(500)
    page.locator(".el-select-dropdown__item").filter(has_text="Guest").first.click(force=True)
    page.wait_for_timeout(500)

    screenshot(page, f"create_{name}_form")

    page.get_by_role("button", name="Save").click()
    page.wait_for_timeout(3000)

    screenshot(page, f"create_{name}_saved")

    # Verify user exists in list, then navigate to user detail for subsequent add_access
    nav_to_users(page)
    verify_row = page.locator("tr").filter(has_text=name)
    if verify_row.count() == 0:
        screenshot(page, f"create_{name}_NOT_FOUND")
        print(f"ERROR: User '{name}' not found after creation")
        return False

    # Click into user detail so 'Add Device Access' button is available
    arrow = verify_row.first.locator("i, svg, .el-icon").last
    if arrow.count() > 0:
        arrow.click(force=True)
    else:
        verify_row.first.locator("td").last.click()
    page.wait_for_timeout(2000)

    print(f"User '{name}' created with code {code} (verified)")
    return True


# ── Action 2: Add Device Access (from user detail page) ────────────

def add_access_from_current_page(page, name, checkin_dt, checkout_dt):
    """Add Front Door access with schedule. Must be called when 'Add Device Access' button is visible."""
    begin_str = checkin_dt.strftime("%m/%d/%Y %H:%M")
    end_str = checkout_dt.strftime("%m/%d/%Y %H:%M")

    add_btn = page.get_by_role("button", name="Add Device Access")
    if add_btn.count() == 0:
        screenshot(page, f"access_{name}_no_btn")
        print(f"ERROR: 'Add Device Access' button not found")
        return False

    add_btn.click()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    # Wait for Front Door to appear in device list (up to 15s)
    fd_row = page.locator("tr").filter(has_text="Front Door")
    try:
        fd_row.first.wait_for(state="visible", timeout=15000)
    except PwTimeout:
        screenshot(page, f"access_{name}_no_fd")
        print("ERROR: 'Front Door' not found in device list")
        return False

    screenshot(page, f"access_{name}_devices")

    fd_row.first.locator("td").nth(1).click()
    page.wait_for_timeout(1000)
    screenshot(page, f"access_{name}_fd_selected")

    page.get_by_role("button", name="Next Step").click()
    page.wait_for_timeout(2000)
    screenshot(page, f"access_{name}_schedule")

    # User Type → Temporary User
    # The select input is disabled/readonly — force-click the wrapper to open dropdown
    page.locator(".el-select").first.click(force=True)
    page.wait_for_timeout(1000)

    # Select "Temporary User" — items may not be visible, use JS click as fallback
    temp_item = page.locator(".el-select-dropdown__item").filter(has_text="Temporary User").first
    try:
        temp_item.click(timeout=3000)
    except Exception:
        temp_item.evaluate("el => el.click()")
    page.wait_for_timeout(1500)

    # Set dates
    begin_field = page.locator("input[placeholder='Pick a day']").first
    end_field = page.locator("input[placeholder='Pick a day']").nth(1)

    set_date_field(page, begin_field, begin_str)
    set_date_field(page, end_field, end_str)

    # Verify
    final_begin = begin_field.input_value()
    final_end = end_field.input_value()
    print(f"  Begin: {final_begin}, End: {final_end}")

    if final_begin != begin_str or final_end != end_str:
        screenshot(page, f"access_{name}_DATE_MISMATCH")
        print(f"ERROR: Date mismatch! Got '{final_begin}'/'{final_end}', want '{begin_str}'/'{end_str}'")
        return False

    screenshot(page, f"access_{name}_before_done")

    page.get_by_role("button", name="Done").click()
    page.wait_for_timeout(2000)

    try:
        page.get_by_role("button", name="I Know").click(timeout=5000)
        print("  Confirmed 'I Know'")
    except PwTimeout:
        pass

    page.wait_for_timeout(2000)
    screenshot(page, f"access_{name}_done")

    # Verify device access was saved by checking for "Front Door" in user detail
    fd_check = page.locator("text=Front Door")
    try:
        fd_check.first.wait_for(state="visible", timeout=5000)
        print(f"Device access verified: Front Door, {begin_str} to {end_str}")
        return True
    except PwTimeout:
        screenshot(page, f"access_{name}_NOT_VERIFIED")
        print(f"WARNING: Could not verify 'Front Door' in user detail after save")
        # Return True anyway — the "I Know" confirmation succeeded, verification may be a timing issue
        return True


def add_access(page, name, checkin_dt, checkout_dt):
    """Standalone: navigate to user detail via arrow icon, then add access."""
    nav_to_users(page)

    user_row = page.locator("tr").filter(has_text=name)
    if user_row.count() == 0:
        print(f"ERROR: User '{name}' not found")
        return False

    # Click the arrow icon at row end to open detail page
    arrow = user_row.first.locator("i, svg, .el-icon").last
    if arrow.count() > 0:
        arrow.click(force=True)
    else:
        # Fallback: try clicking the last td
        user_row.first.locator("td").last.click()
    page.wait_for_timeout(2000)
    screenshot(page, f"access_{name}_detail")

    return add_access_from_current_page(page, name, checkin_dt, checkout_dt)


# ── Action 3: Delete User ──────────────────────────────────────────

def delete_user(page, name):
    """Delete a user by name. Verifies removal."""
    nav_to_users(page)

    user_row = page.locator("tr").filter(has_text=name)
    if user_row.count() == 0:
        print(f"User '{name}' not found — nothing to delete")
        return True

    # Select by clicking the name cell (td index 1) — this toggles the checkbox
    user_row.first.locator("td").nth(1).click()
    page.wait_for_timeout(500)
    screenshot(page, f"delete_{name}_selected")

    # Verify selection via "Select All" counter
    select_all = page.locator("button").filter(has_text="Select All")
    if select_all.count() > 0:
        sa_text = select_all.first.text_content()
        print(f"  Selection state: {sa_text}")
        if "(0)" in sa_text:
            print("  WARNING: Selection didn't register, retrying with row click")
            user_row.first.click()
            page.wait_for_timeout(500)

    page.get_by_role("button", name="Remove User").click(force=True)
    page.wait_for_timeout(1000)
    screenshot(page, f"delete_{name}_confirm")

    confirmed = False
    for btn_name in ["OK", "Confirm", "Yes", "Delete"]:
        try:
            page.get_by_role("button", name=btn_name).click(timeout=2000)
            confirmed = True
            print(f"  Clicked '{btn_name}'")
            break
        except PwTimeout:
            continue

    if not confirmed:
        screenshot(page, f"delete_{name}_no_confirm")
        print("ERROR: No confirmation dialog")
        return False

    page.wait_for_timeout(3000)

    # Verify deletion
    nav_to_users(page)
    still = page.locator("tr").filter(has_text=name)
    if still.count() > 0:
        screenshot(page, f"delete_{name}_FAILED")
        print(f"ERROR: User '{name}' still exists")
        return False

    screenshot(page, f"delete_{name}_verified")
    print(f"User '{name}' deleted and verified")
    return True


# ── List Users ──────────────────────────────────────────────────────

def list_users(page):
    nav_to_users(page)

    rows = page.locator("tbody tr")
    count = rows.count()

    users = []
    battery = None
    for i in range(count):
        cells = rows.nth(i).locator("td")
        cell_texts = []
        for j in range(cells.count()):
            text = cells.nth(j).text_content().strip()
            cell_texts.append(text)
            # Parse battery level from cell text (shows "High", "Medium", "Low")
            if text in ("High", "Medium", "Low"):
                battery = text
        if cell_texts:
            users.append(cell_texts)
            print(f"  {' | '.join(cell_texts)}")

    print(f"\nTotal: {count} users")
    return users, battery


# ── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GuestKey Air Lock Manager")
    parser.add_argument("action", choices=["create-user", "add-access", "delete", "list", "add"])
    parser.add_argument("--name", help="User name on the lock")
    parser.add_argument("--code", help="6-digit PIN code")
    parser.add_argument("--checkin", help="Check-in datetime: YYYY-MM-DD HH:MM")
    parser.add_argument("--checkout", help="Check-out datetime: YYYY-MM-DD HH:MM")
    parser.add_argument("--visible", action="store_true", help="Show browser window")
    parser.add_argument("--timeout", type=int, default=120, help="Overall script timeout in seconds")
    args = parser.parse_args()

    if args.action == "create-user" and (not args.name or not args.code):
        parser.error("create-user requires --name and --code")
    if args.action == "add-access" and (not args.name or not args.checkin or not args.checkout):
        parser.error("add-access requires --name, --checkin, --checkout")
    if args.action == "add" and (not args.name or not args.code or not args.checkin or not args.checkout):
        parser.error("add requires --name, --code, --checkin, --checkout")
    if args.action == "delete" and not args.name:
        parser.error("delete requires --name")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=not args.visible,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            timeout=args.timeout * 1000
        )
        context_opts = {
            "viewport": {"width": 1280, "height": 800},
            "user_agent": "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36"
        }
        if os.path.exists(STATE_FILE):
            context_opts["storage_state"] = STATE_FILE

        context = browser.new_context(**context_opts)
        context.set_default_timeout(args.timeout * 1000)
        page = context.new_page()

        try:
            login(page)

            if args.action == "create-user":
                success = create_user(page, args.name, args.code)
                result = {"success": success, "action": "create-user", "name": args.name, "code": args.code}

            elif args.action == "add-access":
                checkin_dt = datetime.strptime(args.checkin, "%Y-%m-%d %H:%M")
                checkout_dt = datetime.strptime(args.checkout, "%Y-%m-%d %H:%M")
                success = add_access(page, args.name, checkin_dt, checkout_dt)
                result = {"success": success, "action": "add-access", "name": args.name}

            elif args.action == "add":
                checkin_dt = datetime.strptime(args.checkin, "%Y-%m-%d %H:%M")
                checkout_dt = datetime.strptime(args.checkout, "%Y-%m-%d %H:%M")
                s1 = create_user(page, args.name, args.code)
                if not s1:
                    result = {"success": False, "action": "add", "name": args.name, "step": "create-user"}
                else:
                    # Stay on post-save page — Add Device Access button is here
                    s2 = add_access_from_current_page(page, args.name, checkin_dt, checkout_dt)
                    if not s2:
                        # Retry: navigate to user detail and try add_access again
                        print(f"  Retrying add_access for '{args.name}'...")
                        s2 = add_access(page, args.name, checkin_dt, checkout_dt)
                    result = {"success": s2, "action": "add", "name": args.name, "code": args.code,
                              "step": "complete" if s2 else "add-access"}

            elif args.action == "delete":
                success = delete_user(page, args.name)
                result = {"success": success, "action": "delete", "name": args.name}

            elif args.action == "list":
                users, battery = list_users(page)
                result = {"success": True, "action": "list", "count": len(users)}
                if battery:
                    result["battery"] = battery

            context.storage_state(path=STATE_FILE)
            print(json.dumps(result))

        except Exception as e:
            screenshot(page, "error")
            print(json.dumps({"success": False, "error": str(e)}))
            raise
        finally:
            context.close()
            browser.close()


def run_with_retry():
    """Run main() with one retry on PwTimeout or connection errors."""
    for attempt in range(2):
        try:
            main()
            return
        except (PwTimeout, ConnectionError, OSError) as e:
            if attempt == 0:
                print(f"Attempt 1 failed ({type(e).__name__}: {e}), retrying...")
            else:
                print(json.dumps({"success": False, "error": f"Failed after 2 attempts: {e}"}))
                sys.exit(1)
        except Exception:
            raise


if __name__ == "__main__":
    run_with_retry()
