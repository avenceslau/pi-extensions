// Reads one Rust source file on stdin and prints the items the hygiene linter needs as a JSON array,
// or {"error": "..."} when the file does not parse. The optional argument is the nesting depth to report.
use proc_macro2::Span;
use std::io::Read;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

fn start_line(span: Span) -> usize {
    span.start().line
}

fn end_line(span: Span) -> usize {
    span.end().line
}

fn json_type(value_type: Option<&str>) -> String {
    value_type
        .map(|name| format!(r#","valueType":"{}""#, name))
        .unwrap_or_default()
}

// The type the linter checks names against, when the declaration spells it out.
fn declared_type(annotation: &syn::Type) -> Option<&'static str> {
    let syn::Type::Path(path) = annotation else {
        return None;
    };
    let name = path.path.get_ident()?.to_string();
    match name.as_str() {
        "bool" => Some("boolean"),
        "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64" | "i128"
        | "isize" | "f32" | "f64" => Some("number"),
        _ => None,
    }
}

fn literal_type(expr: &syn::Expr) -> Option<&'static str> {
    match expr {
        syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Bool(_),
            ..
        }) => Some("boolean"),
        syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Int(_) | syn::Lit::Float(_),
            ..
        }) => Some("number"),
        _ => None,
    }
}

fn literal_number(lit: &syn::Lit) -> Option<f64> {
    match lit {
        syn::Lit::Int(lit) => lit.base10_digits().parse().ok(),
        syn::Lit::Float(lit) => lit.base10_digits().parse().ok(),
        _ => None,
    }
}

// A literal, or arithmetic on literals and constants, which an immutable binding names.
fn is_numeric_expression(expr: &syn::Expr) -> bool {
    match expr {
        syn::Expr::Lit(literal) => literal_number(&literal.lit).is_some(),
        syn::Expr::Unary(unary) => is_numeric_expression(&unary.expr),
        syn::Expr::Paren(paren) => is_numeric_expression(&paren.expr),
        syn::Expr::Binary(binary) => {
            let operand = |side: &syn::Expr| {
                is_numeric_expression(side) || matches!(side, syn::Expr::Path(_))
            };
            operand(&binary.left) && operand(&binary.right)
        }
        _ => false,
    }
}

fn is_test(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        let test_attribute = attr
            .path()
            .segments
            .last()
            .is_some_and(|segment| segment.ident == "test");
        let cfg_test = attr.path().is_ident("cfg")
            && attr
                .parse_args::<syn::Ident>()
                .is_ok_and(|ident| ident == "test");
        test_attribute || cfg_test
    })
}

fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if (other as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", other as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

struct Collector {
    items: Vec<String>,
    depth: usize,
    max_depth: usize,
    branches: usize,
    deep_nesting: usize,
    function_id: usize,
    function_count: usize,
    // Inside a const, a static or an enum discriminant, where a literal is named.
    named_value_depth: usize,
    in_pattern: bool,
    in_test: bool,
}

impl Collector {
    fn nest<F: FnOnce(&mut Self)>(&mut self, span: Span, visit_children: F) {
        self.depth += 1;
        self.max_depth = self.max_depth.max(self.depth);
        if self.depth >= self.deep_nesting {
            self.items.push(format!(
                r#"{{"kind":"deep","line":{},"endLine":{},"depth":{},"functionId":{}}}"#,
                start_line(span),
                end_line(span),
                self.depth,
                self.function_id
            ));
        }
        self.branches += 1;
        visit_children(self);
        self.depth -= 1;
    }

    // Nesting depth restarts in every function and closure, as in the TypeScript rule.
    fn visit_function_body<F: FnOnce(&mut Self)>(&mut self, visit_body: F) {
        let outer = (self.depth, self.function_id);
        self.depth = 0;
        self.function_count += 1;
        self.function_id = self.function_count;
        visit_body(self);
        (self.depth, self.function_id) = outer;
    }

    fn function(&mut self, sig: &syn::Signature, span: Span, block: &syn::Block, public: bool) {
        for input in &sig.inputs {
            if let syn::FnArg::Typed(typed) = input {
                if let syn::Pat::Ident(pattern) = &*typed.pat {
                    self.named(
                        "param",
                        pattern.ident.to_string(),
                        pattern.ident.span(),
                        declared_type(&typed.ty),
                    );
                }
            }
        }
        let name = sig.ident.to_string();
        self.named("function", name.clone(), sig.ident.span(), None);
        let outer = (self.branches, self.max_depth);
        self.branches = 0;
        self.max_depth = 0;
        self.visit_function_body(|collector| collector.visit_block(block));

        let single_call = block.stmts.len() == 1
            && matches!(
                &block.stmts[0],
                syn::Stmt::Expr(
                    syn::Expr::Call(_) | syn::Expr::MethodCall(_) | syn::Expr::Await(_),
                    _
                )
            );
        self.items.push(format!(
            r#"{{"kind":"fn","name":{},"line":{},"endLine":{},"branches":{},"maxDepth":{},"singleCall":{},"pub":{}}}"#,
            json_string(&name),
            start_line(span),
            end_line(span),
            self.branches,
            self.max_depth,
            single_call,
            public
        ));
        (self.branches, self.max_depth) = outer;
    }

    fn named(&mut self, kind: &str, name: String, span: Span, value_type: Option<&str>) {
        self.items.push(format!(
            r#"{{"kind":"{}","name":{},"line":{},"endLine":{},"column":{}{}}}"#,
            kind,
            json_string(&name),
            start_line(span),
            end_line(span),
            span.start().column + 1,
            json_type(value_type)
        ));
    }

    fn statement(&mut self, span: Span) {
        self.items.push(format!(
            r#"{{"kind":"stmt","line":{},"endLine":{}}}"#,
            start_line(span),
            end_line(span)
        ));
    }

    fn named_value<F: FnOnce(&mut Self)>(&mut self, visit_value: F) {
        self.named_value_depth += 1;
        visit_value(self);
        self.named_value_depth -= 1;
    }

    fn test_code<F: FnOnce(&mut Self)>(&mut self, attrs: &[syn::Attribute], visit_code: F) {
        let outer = self.in_test;
        self.in_test = outer || is_test(attrs);
        visit_code(self);
        self.in_test = outer;
    }

    // Indexes and slice ranges are offsets, which the TypeScript rules leave to magic-offset.
    fn visit_offset(&mut self, index: &syn::Expr) {
        match index {
            syn::Expr::Lit(_) => {}
            syn::Expr::Range(range) => {
                for end in [&range.start, &range.end].into_iter().flatten() {
                    self.visit_offset(end);
                }
            }
            other => self.visit_expr(other),
        }
    }
}

impl<'a> Visit<'a> for Collector {
    fn visit_item_fn(&mut self, item: &'a syn::ItemFn) {
        let public = matches!(item.vis, syn::Visibility::Public(_));
        self.test_code(&item.attrs, |collector| {
            collector.function(&item.sig, item.span(), &item.block, public)
        });
    }

    fn visit_impl_item_fn(&mut self, item: &'a syn::ImplItemFn) {
        let public = matches!(item.vis, syn::Visibility::Public(_));
        self.test_code(&item.attrs, |collector| {
            collector.function(&item.sig, item.span(), &item.block, public)
        });
    }

    fn visit_item_mod(&mut self, item: &'a syn::ItemMod) {
        self.test_code(&item.attrs, |collector| {
            visit::visit_item_mod(collector, item)
        });
    }

    fn visit_item(&mut self, item: &'a syn::Item) {
        self.statement(item.span());
        visit::visit_item(self, item);
    }

    fn visit_impl_item(&mut self, item: &'a syn::ImplItem) {
        self.statement(item.span());
        visit::visit_impl_item(self, item);
    }

    fn visit_trait_item(&mut self, item: &'a syn::TraitItem) {
        self.statement(item.span());
        visit::visit_trait_item(self, item);
    }

    fn visit_stmt(&mut self, stmt: &'a syn::Stmt) {
        self.statement(stmt.span());
        visit::visit_stmt(self, stmt);
    }

    fn visit_arm(&mut self, arm: &'a syn::Arm) {
        self.statement(arm.span());
        visit::visit_arm(self, arm);
    }

    fn visit_pat(&mut self, pat: &'a syn::Pat) {
        let outer = self.in_pattern;
        self.in_pattern = true;
        visit::visit_pat(self, pat);
        self.in_pattern = outer;
    }

    fn visit_type_array(&mut self, array_type: &'a syn::TypeArray) {
        self.visit_type(&array_type.elem);
    }

    fn visit_expr_index(&mut self, expr: &'a syn::ExprIndex) {
        self.visit_expr(&expr.expr);
        self.visit_offset(&expr.index);
    }

    // Doubling and halving read as themselves; `x / 2` needs no name.
    fn visit_expr_binary(&mut self, expr: &'a syn::ExprBinary) {
        let halving = matches!(
            expr.op,
            syn::BinOp::Mul(_)
                | syn::BinOp::Div(_)
                | syn::BinOp::Rem(_)
                | syn::BinOp::Shl(_)
                | syn::BinOp::Shr(_)
        );
        for side in [&*expr.left, &*expr.right] {
            let literal_value = match side {
                syn::Expr::Lit(literal) => literal_number(&literal.lit),
                _ => None,
            };
            let two = matches!(literal_value, Some(number) if number == 2.0 || number == 0.5);
            if !(halving && two) {
                self.visit_expr(side);
            }
        }
    }

    fn visit_expr_lit(&mut self, expr: &'a syn::ExprLit) {
        let named = self.named_value_depth > 0 || self.in_pattern || self.in_test;
        let Some(value) = literal_number(&expr.lit) else {
            return;
        };
        if named || value == 0.0 || value == 1.0 {
            return;
        }
        let start = expr.span().start();
        let text = match &expr.lit {
            syn::Lit::Int(lit) => lit.token().to_string(),
            syn::Lit::Float(lit) => lit.token().to_string(),
            _ => return,
        };
        self.items.push(format!(
            r#"{{"kind":"magic","name":{},"line":{},"column":{}}}"#,
            json_string(&text),
            start.line,
            start.column + 1
        ));
    }

    fn visit_item_static(&mut self, item: &'a syn::ItemStatic) {
        self.named_value(|collector| visit::visit_item_static(collector, item));
    }

    fn visit_impl_item_const(&mut self, item: &'a syn::ImplItemConst) {
        self.named_value(|collector| visit::visit_impl_item_const(collector, item));
    }

    fn visit_variant(&mut self, variant: &'a syn::Variant) {
        self.named_value(|collector| visit::visit_variant(collector, variant));
    }

    fn visit_trait_item_fn(&mut self, item: &'a syn::TraitItemFn) {
        self.visit_function_body(|collector| visit::visit_trait_item_fn(collector, item));
    }

    fn visit_expr_closure(&mut self, expr: &'a syn::ExprClosure) {
        self.visit_function_body(|collector| visit::visit_expr_closure(collector, expr));
    }

    fn visit_expr_if(&mut self, expr: &'a syn::ExprIf) {
        let else_branch = expr.else_branch.as_ref().map(|(_, branch)| &**branch);
        self.nest(expr.span(), |collector| {
            collector.visit_expr(&expr.cond);
            collector.visit_block(&expr.then_branch);
            if let Some(branch @ syn::Expr::Block(_)) = else_branch {
                collector.visit_expr(branch);
            }
        });
        // An else-if stays at the depth of the if it continues, as in the TypeScript rule.
        if let Some(syn::Expr::If(else_if)) = else_branch {
            self.visit_expr_if(else_if);
        }
    }

    fn visit_expr_match(&mut self, expr: &'a syn::ExprMatch) {
        self.nest(expr.span(), |collector| {
            visit::visit_expr_match(collector, expr)
        });
    }

    fn visit_expr_for_loop(&mut self, expr: &'a syn::ExprForLoop) {
        self.nest(expr.span(), |collector| {
            visit::visit_expr_for_loop(collector, expr)
        });
    }

    fn visit_expr_while(&mut self, expr: &'a syn::ExprWhile) {
        self.nest(expr.span(), |collector| {
            visit::visit_expr_while(collector, expr)
        });
    }

    fn visit_expr_loop(&mut self, expr: &'a syn::ExprLoop) {
        self.nest(expr.span(), |collector| {
            visit::visit_expr_loop(collector, expr)
        });
    }

    fn visit_local(&mut self, local: &'a syn::Local) {
        let initializer_type = local
            .init
            .as_ref()
            .and_then(|init| literal_type(&init.expr));
        let mut immutable = false;
        match &local.pat {
            syn::Pat::Ident(pattern) => {
                immutable = pattern.mutability.is_none();
                self.named(
                    "ident",
                    pattern.ident.to_string(),
                    pattern.ident.span(),
                    initializer_type,
                );
            }
            syn::Pat::Type(typed) => {
                if let syn::Pat::Ident(pattern) = &*typed.pat {
                    immutable = pattern.mutability.is_none();
                    self.named(
                        "ident",
                        pattern.ident.to_string(),
                        pattern.ident.span(),
                        declared_type(&typed.ty),
                    );
                }
            }
            syn::Pat::Wild(pattern) => self.items.push(format!(
                r#"{{"kind":"let_underscore","line":{}}}"#,
                start_line(pattern.span())
            )),
            _ => {}
        }
        let named_number = local
            .init
            .as_ref()
            .is_some_and(|init| immutable && is_numeric_expression(&init.expr));
        if named_number {
            self.named_value(|collector| visit::visit_local(collector, local));
        } else {
            visit::visit_local(self, local);
        }
    }

    fn visit_item_struct(&mut self, item: &'a syn::ItemStruct) {
        self.named("type", item.ident.to_string(), item.ident.span(), None);
        for field in item.fields.iter() {
            if let Some(ident) = &field.ident {
                self.named("field", ident.to_string(), ident.span(), None);
            }
        }
        visit::visit_item_struct(self, item);
    }

    fn visit_item_enum(&mut self, item: &'a syn::ItemEnum) {
        self.named("type", item.ident.to_string(), item.ident.span(), None);
        visit::visit_item_enum(self, item);
    }

    fn visit_item_const(&mut self, item: &'a syn::ItemConst) {
        self.named(
            "const",
            item.ident.to_string(),
            item.ident.span(),
            declared_type(&item.ty),
        );
        self.named_value(|collector| visit::visit_item_const(collector, item));
    }
}

fn main() {
    let mut source = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut source) {
        println!(r#"{{"error":{}}}"#, json_string(&error.to_string()));
        return;
    }

    match syn::parse_file(&source) {
        Ok(file) => {
            let mut collector = Collector {
                items: Vec::new(),
                depth: 0,
                max_depth: 0,
                branches: 0,
                function_id: 0,
                function_count: 0,
                named_value_depth: 0,
                in_pattern: false,
                in_test: false,
                deep_nesting: std::env::args()
                    .nth(1)
                    .and_then(|depth| depth.parse().ok())
                    .unwrap_or(4),
            };
            collector.visit_file(&file);
            println!("[{}]", collector.items.join(","));
        }
        Err(error) => println!(r#"{{"error":{}}}"#, json_string(&error.to_string())),
    }
}
